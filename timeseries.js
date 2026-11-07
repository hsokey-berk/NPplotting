// ---- Moisture change through time (separate mode) ----
//
// Self-contained: reads the parsed `rows` array and the config constants, and
// only touches the elements that belong to this mode (#tsProfile, #tsTime,
// #tsReadout and the ts* controls). The one exception is the hand-off back to
// the standard plot when leaving this mode (see handOff()).
//
// Each visit date is its own survey. Repeated readings at the same depth on
// one date are averaged so each depth has one value. Moisture differences are
// shown in mm (equivalent water depth: integral of Delta-Theta over depth).

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DAY = 86400000;
  const DAYS_PER_MONTH = 30.4375;
  const FT_TO_M = 0.3048;
  const DEPTH_TOL = 0.31; // m; a survey may fall one 1-ft step short of the depth window
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const dayOf = (y, m, d) => Date.UTC(y, m - 1, d) / DAY;
  const yearOfDay = (t) => new Date(Math.floor(t + 1e-9) * DAY).getUTCFullYear();
  const startOfYear = (y) => Date.UTC(y, 0, 1) / DAY;
  const isoDate = (t) => new Date(Math.floor(t + 1e-9) * DAY).toISOString().slice(0, 10);

  function fmtDate(t) {
    const d = new Date(Math.floor(t + 1e-9) * DAY);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }

  // playback speeds in calendar months per second (config value is merged in)
  const cfgSpeed = (typeof TS_MONTHS_PER_SECOND === "number" && TS_MONTHS_PER_SECOND > 0) ? TS_MONTHS_PER_SECOND : 1;
  const SPEEDS = [...new Set([0.25, 0.5, 1, 2, 4, 8, 16, cfgSpeed])].sort((a, b) => a - b);

  const S = {
    active: false,
    surveys: [],
    P: null,
    T: 0,                         // current time, in days (fractional)
    playing: false,
    speedIdx: SPEEDS.indexOf(cfgSpeed),
    raf: null,
    last: null,
    lastRender: 0,
    // requested range (days); persists across hole/site changes
    reqStart: (typeof TS_DEFAULT_START !== "undefined")
      ? dayOf(TS_DEFAULT_START.year, TS_DEFAULT_START.month, TS_DEFAULT_START.day || 1)
      : dayOf(2025, 5, 1),
    startIsDefault: true,
    reqEnd: Infinity,
    rain: null,                   // {days, C} once loaded
    rainStatus: "off"             // off | loading | ready | error
  };

  // ---------- data ----------

  const thetaOf = (count) => THETA_SLOPE * count + THETA_INTERCEPT;

  // One survey per visit date for this site + hole (meters / Theta); repeated
  // depths on the same date are averaged.
  function buildSurveys(site, hole) {
    const byDay = new Map();
    rows.forEach((r) => {
      if (r.site !== site || r.holeId !== hole) return;
      const t = dayOf(r.date.year, r.date.month, r.date.day);
      let m = byDay.get(t);
      if (!m) { m = { t, y: r.date.year, m: r.date.month, d: r.date.day, depthMap: new Map() }; byDay.set(t, m); }
      const depth = Math.round(r.cableFt * FT_TO_M * 1e6) / 1e6;
      const th = thetaOf(r.neutron);
      const acc = m.depthMap.get(depth);
      if (acc) { acc.sum += th; acc.n += 1; } else m.depthMap.set(depth, { sum: th, n: 1 });
    });

    return [...byDay.values()]
      .map((m) => {
        const pts = [...m.depthMap.entries()].map(([d, a]) => [d, a.sum / a.n]).sort((x, y) => x[0] - y[0]);
        return { t: m.t, y: m.y, m: m.m, d: m.d, depths: pts.map((p) => p[0]), values: pts.map((p) => p[1]) };
      })
      .filter((s) => s.depths.length >= 2)
      .sort((a, b) => a.t - b.t);
  }

  // ---------- math ----------

  function interp(ds, vs, x) { // ds strictly increasing; held constant outside the range
    const last = ds.length - 1;
    if (x <= ds[0]) return vs[0];
    if (x >= ds[last]) return vs[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ds[mid] <= x) lo = mid; else hi = mid;
    }
    return vs[lo] + (vs[hi] - vs[lo]) * (x - ds[lo]) / (ds[hi] - ds[lo]);
  }

  function trapz(xs, ys) {
    let total = 0;
    for (let i = 0; i < xs.length - 1; i++) total += 0.5 * (ys[i] + ys[i + 1]) * (xs[i + 1] - xs[i]);
    return total;
  }

  // The depth window is the overlap of the START and END surveys. Intermediate
  // surveys that don't cover that window (partial profiles) are skipped.
  function prepare(surveys, startT, endT) {
    const inRange = surveys.filter((s) => s.t >= startT && s.t <= endT);
    if (inRange.length < 2) return { error: "Need at least two visits in the selected range." };

    const first = inRange[0], lastS = inRange[inRange.length - 1];
    const lo = Math.max(first.depths[0], lastS.depths[0]);
    const hi = Math.min(first.depths[first.depths.length - 1], lastS.depths[lastS.depths.length - 1]);
    if (!(lo < hi)) return { error: "The start and end visits share no common depth range." };

    const covers = (s) => s.depths[0] <= lo + DEPTH_TOL && s.depths[s.depths.length - 1] >= hi - DEPTH_TOL;
    const sub = inRange.filter((s, i) => i === 0 || i === inRange.length - 1 || covers(s));
    const skipped = inRange.filter((s) => !sub.includes(s));

    const set = new Set([lo, hi]);
    sub.forEach((s) => s.depths.forEach((d) => { if (d >= lo && d <= hi) set.add(d); }));
    const grid = [...set].sort((a, b) => a - b);

    const gridVals = sub.map((s) => grid.map((d) => interp(s.depths, s.values, d)));
    const base = gridVals[0];
    const cum = gridVals.map((g) => trapz(grid, g.map((v, i) => v - base[i])));

    let maxAbs = 0;
    gridVals.forEach((g) => g.forEach((v, i) => { maxAbs = Math.max(maxAbs, Math.abs(v - base[i])); }));
    if (maxAbs === 0) maxAbs = 1e-9;

    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    sub.forEach((s) => {
      s.values.forEach((v) => { xmin = Math.min(xmin, v); xmax = Math.max(xmax, v); });
      ymin = Math.min(ymin, s.depths[0]);
      ymax = Math.max(ymax, s.depths[s.depths.length - 1]);
    });
    const xpad = (xmax - xmin) * 0.06 || 0.01;
    const ypad = (ymax - ymin) * 0.03 || 0.1;

    return {
      sub, skipped, grid, gridVals, cum, maxAbs,
      T0: sub[0].t, T1: sub[sub.length - 1].t,
      xRange: [xmin - xpad, xmax + xpad],
      yRange: [ymax + ypad, Math.max(0, ymin - ypad)],
      overlap: [lo, hi],
      limited: lo > first.depths[0] + 1e-9 || hi < first.depths[first.depths.length - 1] - 1e-9
    };
  }

  // Profile and cumulative net change at time T (days), interpolated linearly in
  // time between the two surrounding surveys.
  function frameAt(P, T) {
    const sv = P.sub, n = sv.length;
    let k, f;
    if (T <= sv[0].t) { k = 0; f = 0; }
    else if (T >= sv[n - 1].t) { k = n - 2; f = 1; }
    else {
      k = 0;
      while (sv[k + 1].t < T) k++;
      f = (T - sv[k].t) / (sv[k + 1].t - sv[k].t);
    }
    const a = P.gridVals[k], b = P.gridVals[k + 1];
    return { vals: a.map((v, i) => v + (b[i] - v) * f), net: P.cum[k] + (P.cum[k + 1] - P.cum[k]) * f };
  }

  // ---------- shading (colour ramp by local difference) ----------

  function rampColor(bin) {
    const u = (Math.abs(bin) - 1) / 4;
    const lerp = (a, b) => Math.round(a + (b - a) * u);
    const c = bin > 0
      ? [lerp(190, 20), lerp(220, 90), lerp(245, 170)]
      : [lerp(245, 160), lerp(215, 60), lerp(190, 20)];
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.6)`;
  }

  function binOf(mean, maxAbs) {
    if (Math.abs(mean) < maxAbs * 1e-6) return 0;
    const lvl = Math.min(5, Math.max(1, Math.ceil(Math.abs(mean) / maxAbs * 5 - 1e-9)));
    return mean > 0 ? lvl : -lvl;
  }

  function buildShading(grid, a, b, maxAbs) {
    const d = [grid[0]], av = [a[0]], bv = [b[0]], df = [b[0] - a[0]];
    for (let i = 0; i < grid.length - 1; i++) {
      const v0 = b[i] - a[i], v1 = b[i + 1] - a[i + 1];
      if ((v0 > 0 && v1 < 0) || (v0 < 0 && v1 > 0)) {
        const t = v0 / (v0 - v1);
        d.push(grid[i] + t * (grid[i + 1] - grid[i]));
        av.push(a[i] + t * (a[i + 1] - a[i]));
        bv.push(b[i] + t * (b[i + 1] - b[i]));
        df.push(0);
      }
      d.push(grid[i + 1]); av.push(a[i + 1]); bv.push(b[i + 1]); df.push(v1);
    }

    const net = trapz(d, df);
    const total = trapz(d, df.map(Math.abs));

    const shapes = [];
    const flush = (run) => {
      if (!run || run.bin === 0) return;
      const parts = [`M ${av[run.start]},${d[run.start]}`];
      for (let i = run.start + 1; i <= run.end; i++) parts.push(`L ${av[i]},${d[i]}`);
      for (let i = run.end; i >= run.start; i--) parts.push(`L ${bv[i]},${d[i]}`);
      parts.push("Z");
      shapes.push({ type: "path", path: parts.join(" "), xref: "x", yref: "y", fillcolor: rampColor(run.bin), line: { width: 0 }, layer: "below" });
    };

    let run = null;
    for (let i = 0; i < d.length - 1; i++) {
      const bin = binOf((df[i] + df[i + 1]) / 2, maxAbs);
      if (run && run.bin === bin) run.end = i + 1;
      else { flush(run); run = { bin, start: i, end: i + 1 }; }
    }
    flush(run);
    return { shapes, net, total };
  }

  // ---------- rainfall (cumulative datastream that resets each Oct 1) ----------

  function parseTime(str) {
    if (str == null) return null;
    const s = String(str).trim();
    if (!/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return null;
    const ms = Date.parse(s);
    return isNaN(ms) ? null : ms;
  }

  // Daily end-of-day cumulative values -> reset-corrected running total C.
  // A drop to under half the previous value is treated as a reset to zero
  // (the new value is that day's rain); smaller drops are treated as noise.
  function parseRainRows(data, fields, timeCol, valCol) {
    const sample = (col) => { for (const r of data) if (r[col] != null && String(r[col]).trim() !== "") return r[col]; return null; };
    let tc = timeCol && fields.includes(timeCol) ? timeCol : fields.find((f) => parseTime(sample(f)) !== null);
    if (!tc) return { error: `No time column found. Columns: ${fields.join(", ")}` };
    let vc = valCol && fields.includes(valCol) ? valCol : null;
    if (!vc) {
      const cands = fields.filter((f) => f !== tc && isFinite(parseFloat(sample(f))));
      vc = cands.find((f) => /rain|precip|cumul/i.test(f)) || cands[0];
    }
    if (!vc) return { error: `No numeric value column found. Columns: ${fields.join(", ")}` };

    const pts = [];
    data.forEach((r) => {
      const ms = parseTime(r[tc]);
      const v = parseFloat(r[vc]);
      if (ms !== null && isFinite(v)) pts.push([ms, v]);
    });
    if (pts.length < 2) return { error: "Fewer than two usable rainfall rows." };
    pts.sort((a, b) => a[0] - b[0]);

    const daily = new Map();
    pts.forEach(([ms, v]) => daily.set(Math.floor(ms / DAY), v)); // last value of each day
    const dayKeys = [...daily.keys()].sort((a, b) => a - b);
    const vals = dayKeys.map((k) => daily.get(k));

    const days = dayKeys.map((k) => k + 1); // end-of-day value, attributed to the end of that day
    const C = [0];
    for (let i = 1; i < vals.length; i++) {
      const dv = vals[i] - vals[i - 1];
      const inc = dv >= 0 ? dv : (vals[i] < 0.5 * vals[i - 1] ? vals[i] : 0);
      C.push(C[i - 1] + inc);
    }
    return { days, C, timeCol: tc, valCol: vc };
  }

  function rainAt(R, t) { // running total at time t (days), linear between daily points
    const { days, C } = R;
    if (t <= days[0]) return C[0];
    if (t >= days[days.length - 1]) return C[C.length - 1];
    let lo = 0, hi = days.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (days[mid] <= t) lo = mid; else hi = mid; }
    return C[lo] + (C[hi] - C[lo]) * (t - days[lo]) / (days[hi] - days[lo]);
  }

  const rainCovers = (R, T0, T1) => R.days[0] <= T0 + 2 && R.days[R.days.length - 1] >= T1 - 2;

  function loadRain() {
    if (S.rainStatus !== "off") return;
    const file = (typeof RAIN_CSV_FILENAME === "string") ? RAIN_CSV_FILENAME.trim() : "";
    if (!file || typeof Papa === "undefined") return;
    S.rainStatus = "loading";
    Papa.parse(file, {
      download: true, header: true, skipEmptyLines: true,
      complete: (res) => {
        const out = parseRainRows(
          res.data, (res.meta && res.meta.fields) || [],
          typeof RAIN_TIME_COLUMN === "string" ? RAIN_TIME_COLUMN.trim() : "",
          typeof RAIN_VALUE_COLUMN === "string" ? RAIN_VALUE_COLUMN.trim() : ""
        );
        if (out.error) { S.rainStatus = "error"; S.rainError = out.error; } else { S.rain = out; S.rainStatus = "ready"; }
        if (S.active) setup();
      },
      error: () => { S.rainStatus = "error"; S.rainError = `Could not load ${file}.`; if (S.active) setup(); }
    });
  }

  // ---------- figures ----------

  function initFigures() {
    const P = S.P;
    const first = P.sub[0];
    const cfg = { responsive: true, displaylogo: false };

    const colorbar = {
      x: [P.xRange[0]], y: [P.yRange[1]], mode: "markers", type: "scatter", showlegend: false, hoverinfo: "skip",
      marker: {
        color: [0], opacity: 0, size: 1,
        colorscale: [[0, "rgb(160,60,20)"], [0.5, "rgb(255,255,255)"], [1, "rgb(20,90,170)"]],
        cmin: -P.maxAbs, cmax: P.maxAbs, showscale: true,
        colorbar: { title: { text: "\u0394\u03b8" }, thickness: 12, len: 0.55, x: 1.02 }
      }
    };

    Plotly.newPlot("tsProfile", [
      { x: first.values, y: first.depths, mode: "lines+markers", name: `Start: ${fmtDate(first.t)}`, line: { color: "#1E2624", width: 2.5 }, marker: { size: 5 } },
      { x: P.gridVals[0], y: P.grid, mode: "lines", name: "Now", line: { color: "#2F6F62", width: 2.5 } },
      colorbar
    ], {
      xaxis: { title: { text: "Theta", standoff: 8 }, side: "top", range: P.xRange },
      yaxis: { title: "Cable length (m)", range: P.yRange },
      font: { family: "IBM Plex Sans", color: "#1E2624" },
      plot_bgcolor: "#FFFFFF", paper_bgcolor: "#FFFFFF",
      margin: { t: 70, r: 80, l: 60, b: 50 },
      legend: { orientation: "h", y: -0.1 },
      shapes: []
    }, cfg);

    const cumMm = P.cum.map((v) => v * 1000);
    const steps = P.sub.slice(1).map((s, i) => cumMm[i + 1] - cumMm[i]);
    const traces = [
      {
        type: "bar", x: P.sub.slice(1).map((s) => isoDate(s.t)), y: steps, name: "Change since previous visit",
        marker: { color: steps.map((v) => (v >= 0 ? "rgba(74,144,194,0.45)" : "rgba(164,85,46,0.45)")) }
      },
      { x: P.sub.map((s) => isoDate(s.t)), y: cumMm, mode: "lines+markers", name: "Net change vs start", line: { color: "#1E2624", width: 2 }, marker: { size: 6 } },
      { x: [isoDate(P.T0)], y: [0], mode: "markers", name: "Now", marker: { size: 12, color: "#2F6F62", line: { color: "#FFFFFF", width: 2 } } }
    ];

    const layout = {
      title: { text: "Moisture difference through time", font: { size: 14 } },
      xaxis: { type: "date" },
      yaxis: { title: "\u0394 moisture (mm)", zeroline: true },
      font: { family: "IBM Plex Sans", color: "#1E2624" },
      plot_bgcolor: "#FFFFFF", paper_bgcolor: "#FFFFFF",
      margin: { t: 50, r: 30, l: 70, b: 50 },
      legend: { orientation: "h", y: -0.2 }
    };

    if (P.rainOn) {
      const rd = S.rain.days.filter((d) => d >= P.T0 && d <= P.T1);
      const r0 = rainAt(S.rain, P.T0);
      traces.push(
        { x: [P.T0, ...rd, P.T1].map(isoDate), y: [0, ...rd.map((d) => rainAt(S.rain, d) - r0), rainAt(S.rain, P.T1) - r0], yaxis: "y2", mode: "lines", name: "Rainfall since start", line: { color: "rgba(60,120,190,0.9)", width: 1.5, shape: "linear" }, fill: "tozeroy", fillcolor: "rgba(60,120,190,0.12)" },
        { x: [isoDate(P.T0)], y: [0], yaxis: "y2", mode: "markers", name: "Rain now", showlegend: false, marker: { size: 9, color: "rgba(60,120,190,1)", line: { color: "#FFFFFF", width: 2 } } }
      );
      layout.yaxis2 = { title: "Rainfall since start (mm)", overlaying: "y", side: "right", showgrid: false, rangemode: "tozero" };
      layout.margin.r = 70;
    }
    Plotly.newPlot("tsTime", traces, layout, cfg);
  }

  const signed = (v) => (v >= 0 ? "+" : "") + v.toFixed(2);

  function render(T) {
    const P = S.P;
    if (!P) return;
    const fr = frameAt(P, T);
    const sh = buildShading(P.grid, P.gridVals[0], fr.vals, P.maxAbs);
    const nowLabel = fmtDate(T);

    Plotly.restyle("tsProfile", { x: [fr.vals], y: [P.grid], name: [`Now: ${nowLabel}`] }, [1]);
    Plotly.relayout("tsProfile", { shapes: sh.shapes });

    const nowIso = new Date(T * DAY).toISOString();
    let rainNow = null;
    if (P.rainOn) {
      rainNow = rainAt(S.rain, T) - rainAt(S.rain, P.T0);
      Plotly.restyle("tsTime", { x: [[nowIso], [nowIso]], y: [[fr.net * 1000], [rainNow]] }, [2, 4]);
    } else {
      Plotly.restyle("tsTime", { x: [[nowIso]], y: [[fr.net * 1000]] }, [2]);
    }

    const crossed = Math.abs(sh.total - Math.abs(sh.net)) > 1e-9 * Math.max(1, sh.total);
    $("tsReadout").textContent =
      `${fmtDate(P.T0)} \u2192 ${fmtDate(P.T1)}  |  now ${nowLabel}  |  net change vs start ${signed(sh.net * 1000)} mm` +
      (crossed ? `  |  total area ${(sh.total * 1000).toFixed(2)} mm` : "") +
      (rainNow !== null ? `  |  rain since start ${rainNow.toFixed(1)} mm` : "");

    $("tsScrub").value = String(Math.round(((T - P.T0) / (P.T1 - P.T0)) * 1000));
  }

  // ---------- playback ----------

  const speedLabel = () => `${SPEEDS[S.speedIdx]} mo/s`;

  function setPlayLabel() {
    const P = S.P;
    $("tsPlayBtn").textContent = S.playing ? "Pause" : (P && S.T >= P.T1 - 1e-9 ? "Replay" : "Play");
  }

  function setSpeed(i) {
    S.speedIdx = Math.min(SPEEDS.length - 1, Math.max(0, i));
    $("tsSpeedLabel").textContent = speedLabel();
  }

  function pause() {
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = null;
    setPlayLabel();
  }

  function play() {
    if (!S.P) return;
    if (S.T >= S.P.T1 - 1e-9) S.T = S.P.T0;
    S.playing = true;
    S.last = null;
    setPlayLabel();
    S.raf = requestAnimationFrame(tick);
  }

  function tick(ts) {
    if (!S.playing) return;
    if (S.last == null) S.last = ts;
    const dt = (ts - S.last) / 1000;
    S.last = ts;
    S.T = Math.min(S.P.T1, S.T + dt * SPEEDS[S.speedIdx] * DAYS_PER_MONTH);
    const done = S.T >= S.P.T1 - 1e-9;
    if (done || ts - S.lastRender >= 33) { render(S.T); S.lastRender = ts; }
    if (done) pause(); else S.raf = requestAnimationFrame(tick);
  }

  // jump to the next/previous visit date
  function step(dir) {
    if (!S.P) return;
    pause();
    const ts = S.P.sub.map((s) => s.t);
    let target = null;
    if (dir > 0) target = ts.find((t) => t > S.T + 1e-6);
    else ts.forEach((t) => { if (t < S.T - 1e-6) target = t; });
    if (target == null) return;
    S.T = target;
    render(S.T);
    setPlayLabel();
  }

  // ---------- start / end pickers (year + visit date, limited to dates with data) ----------

  function yearsAvailable() {
    return [...new Set(S.surveys.map((s) => s.y))].sort((a, b) => b - a);
  }

  function fillDates(which, wantDoy) {
    const year = parseInt($(`ts${which}Year`).value, 10);
    const list = S.surveys.filter((s) => s.y === year);
    const base = startOfYear(year);
    const pick = list.reduce((best, s) => (Math.abs(s.t - base - wantDoy) < Math.abs(best.t - base - wantDoy) ? s : best), list[0]);
    $(`ts${which}Date`).innerHTML = list.map((s) => `<option value="${s.t}">${MONTHS[s.m - 1]} ${s.d}</option>`).join("");
    $(`ts${which}Date`).value = String(pick.t);
  }

  function fillEndpoint(which, t) {
    const ySel = $(`ts${which}Year`);
    ySel.innerHTML = yearsAvailable().map((y) => `<option value="${y}">${y}</option>`).join("");
    ySel.value = String(yearOfDay(t));
    fillDates(which, t - startOfYear(yearOfDay(t)));
  }

  const readEndpoint = (which) => parseFloat($(`ts${which}Date`).value);

  // first visit on/after the requested start, last visit on/before the requested end
  function resolveRange() {
    const sv = S.surveys;
    const start = sv.find((s) => s.t >= S.reqStart) || sv[0];
    let end = null;
    sv.forEach((s) => { if (s.t <= S.reqEnd) end = s; });
    end = end || sv[sv.length - 1];
    const adjusted = (!S.startIsDefault && start.t !== S.reqStart) || (isFinite(S.reqEnd) && end.t !== S.reqEnd);
    return { start: start.t, end: end.t, adjusted };
  }

  // ---------- setup / mode ----------

  function clearFigures(message) {
    pause();
    S.P = null;
    try { Plotly.purge("tsProfile"); Plotly.purge("tsTime"); } catch (e) { /* nothing plotted yet */ }
    $("tsReadout").textContent = "";
    $("tsNote").textContent = message || "";
  }

  function setup(extraNotes) {
    pause();
    const startT = readEndpoint("Start");
    const endT = readEndpoint("End");

    if (!S.surveys.length) return clearFigures("No visits with data for this hole.");
    if (endT === startT) return clearFigures("Only one visit in this range for this hole.");
    if (endT < startT) return clearFigures("No visits in this range for this hole (end is before start).");

    const P = prepare(S.surveys, startT, endT);
    if (P.error) return clearFigures(P.error);

    P.rainOn = false;
    const notes = extraNotes ? [...extraNotes] : [];
    if (S.rainStatus === "ready") {
      if (rainCovers(S.rain, P.T0, P.T1)) P.rainOn = true;
      else notes.push(`Rainfall data covers ${isoDate(S.rain.days[0])} to ${isoDate(S.rain.days[S.rain.days.length - 1])}, not this whole range.`);
    } else if (S.rainStatus === "error") notes.push(`Rainfall: ${S.rainError}`);

    S.P = P;
    S.T = P.T0;

    if (P.limited) notes.push(`Depth window set by the start/end visits: ${P.overlap[0].toFixed(2)}\u2013${P.overlap[1].toFixed(2)} m.`);
    if (P.skipped.length) {
      const shown = P.skipped.slice(0, 4).map((s) => fmtDate(s.t)).join("; ");
      notes.push(`Skipped visits that don't cover that window: ${shown}${P.skipped.length > 4 ? ` +${P.skipped.length - 4} more` : ""}.`);
    }
    $("tsNote").textContent = notes.join(" ");

    initFigures();
    render(S.T);
    setPlayLabel();
  }

  function onSelectionChanged() {
    if (typeof rows === "undefined" || rows.length === 0) return clearFigures("Data not loaded yet.");
    S.surveys = buildSurveys($("siteSelect").value, $("holeSelect").value);
    if (!S.surveys.length) return clearFigures("No visits with data for this hole.");
    const r = resolveRange();
    fillEndpoint("Start", r.start);
    fillEndpoint("End", r.end);
    setup(r.adjusted ? ["Range adjusted to the visits this hole has."] : []);
  }

  function enter() {
    document.body.classList.add("tsMode");
    S.active = true;
    loadRain();
    onSelectionChanged();
  }

  // Carry the current interval over to the standard plot: its start and end
  // months become the two checked plots, with the moisture difference turned on.
  // (Standard mode works by calendar month, so two visits in the same month
  // collapse to one plot.)
  function handOff() {
    try {
      if (!S.P || typeof checkedCombos === "undefined") return;
      const a = S.P.sub[0], b = S.P.sub[S.P.sub.length - 1];
      const keys = new Set([`${a.y}-${a.m}`, `${b.y}-${b.m}`]);
      checkedCombos.clear();
      keys.forEach((k) => checkedCombos.add(k));
      renderCompareChecks();
      const cb = $("shadeAreaCheckbox");
      cb.checked = keys.size === 2;
      if (cb.checked) cb.dispatchEvent(new Event("change")); // forces m + Theta and replots
      else plot();
    } catch (e) { /* leave the standard plot as it was */ }
  }

  function leave() {
    pause();
    S.active = false;
    document.body.classList.remove("tsMode"); // show the standard plot before drawing into it
    handOff();
    try { Plotly.Plots.resize("plot"); } catch (e) { /* plot not drawn yet */ }
  }

  // ---------- wiring ----------

  const click = (id, fn) => $(id).addEventListener("click", (e) => { fn(); e.currentTarget.blur(); });

  $("modeSelect").addEventListener("change", (e) => (e.target.value === "timeseries" ? enter() : leave()));
  $("siteSelect").addEventListener("change", () => { if (S.active) onSelectionChanged(); });
  $("holeSelect").addEventListener("change", () => { if (S.active) onSelectionChanged(); });

  ["Start", "End"].forEach((which) => {
    const commit = () => {
      if (!S.active) return;
      if (which === "Start") { S.reqStart = readEndpoint("Start"); S.startIsDefault = false; } else S.reqEnd = readEndpoint("End");
      setup();
    };
    $(`ts${which}Year`).addEventListener("change", () => {
      const prev = readEndpoint(which);
      fillDates(which, prev - startOfYear(yearOfDay(prev)));
      commit();
    });
    $(`ts${which}Date`).addEventListener("change", commit);
  });

  click("tsPlayBtn", () => (S.playing ? pause() : play()));
  click("tsPrevBtn", () => step(-1));
  click("tsNextBtn", () => step(1));
  click("tsSlowBtn", () => setSpeed(S.speedIdx - 1));
  click("tsFastBtn", () => setSpeed(S.speedIdx + 1));
  click("tsRestartBtn", () => { if (!S.P) return; pause(); S.T = S.P.T0; render(S.T); play(); });

  $("tsScrub").addEventListener("input", () => {
    if (!S.P) return;
    pause();
    S.T = S.P.T0 + (S.P.T1 - S.P.T0) * (parseInt($("tsScrub").value, 10) / 1000);
    render(S.T);
    setPlayLabel();
  });

  // Space: play/pause, left/right: previous/next visit, up/down: speed
  document.addEventListener("keydown", (e) => {
    if (!S.active || !S.P) return;
    const tag = e.target && e.target.tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    if (e.key === " ") { e.preventDefault(); if (S.playing) pause(); else play(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSpeed(S.speedIdx + 1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSpeed(S.speedIdx - 1); }
  });

  setSpeed(S.speedIdx);

  // exposed for testing only
  window.NPTimeSeries = { buildSurveys, prepare, frameAt, buildShading, parseRainRows, rainAt, state: S, render, setup, enter, leave, step, setSpeed, SPEEDS };
})();
