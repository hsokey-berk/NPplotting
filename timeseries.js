// ---- Moisture change through time (separate mode) ----
//
// Self-contained: only reads the parsed `rows` array and THETA_* constants,
// and only touches the elements that belong to this mode (#tsProfile,
// #tsTime, #tsReadout and the ts* controls). The standard plot code in
// script.js is not modified or called from here.
//
// Units are fixed to meters + Theta, so integrating Delta-Theta over depth
// gives an equivalent water depth in meters.
//
// Within one calendar month, readings taken at the same depth (repeat
// counts, or several visits pooled into the month) are averaged so each
// depth has a single value. This differs from the standard plot, which
// does not average them.
//
// Moisture differences are displayed in mm (equivalent water depth).

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const FT_TO_M = 0.3048;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;

  const S = {
    active: false,
    surveys: [],
    P: null,        // prepared analysis for the selected range
    T: 0,           // current animation time, in calendar months (year*12 + month-1, fractional)
    playing: false,
    speed: (typeof TS_MONTHS_PER_SECOND === "number" && TS_MONTHS_PER_SECOND > 0) ? TS_MONTHS_PER_SECOND : 1,
    reqStart: (typeof TS_DEFAULT_START !== "undefined") ? TS_DEFAULT_START.year * 12 + (TS_DEFAULT_START.month - 1) : 2025 * 12 + 4,
    reqEnd: Infinity,  // requested range persists across hole changes
    raf: null,
    last: null,
    lastRender: 0
  };

  // ---------- data ----------

  function thetaOf(count) {
    return THETA_SLOPE * count + THETA_INTERCEPT;
  }

  // One survey per (year, month) with data for this site + hole, in meters / Theta,
  // with repeated depths averaged.
  function buildSurveys(site, hole) {
    const byIdx = new Map();
    rows.forEach((r) => {
      if (r.site !== site || r.holeId !== hole) return;
      const idx = r.date.year * 12 + (r.date.month - 1);
      let m = byIdx.get(idx);
      if (!m) {
        m = { idx, depthMap: new Map(), nRaw: 0, days: new Set() };
        byIdx.set(idx, m);
      }
      const d = Math.round(r.cableFt * FT_TO_M * 1e6) / 1e6;
      const acc = m.depthMap.get(d);
      const t = thetaOf(r.neutron);
      if (acc) { acc.sum += t; acc.n += 1; } else { m.depthMap.set(d, { sum: t, n: 1 }); }
      m.nRaw += 1;
      m.days.add(r.date.day);
    });

    return [...byIdx.values()]
      .map((m) => {
        const pts = [...m.depthMap.entries()]
          .map(([d, a]) => [d, a.sum / a.n])
          .sort((x, y) => x[0] - y[0]);
        return { idx: m.idx, depths: pts.map((p) => p[0]), values: pts.map((p) => p[1]), nRaw: m.nRaw, nDates: m.days.size };
      })
      .filter((s) => s.depths.length >= 2)
      .sort((a, b) => a.idx - b.idx);
  }

  // ---------- math ----------

  // depths strictly increasing
  function interp(ds, vs, x) {
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

  // Put every survey in the range on one shared depth grid (the overlapping
  // depth range of all of them), and precompute the cumulative net change of
  // each survey relative to the first.
  function prepare(surveys, startIdx, endIdx) {
    const sub = surveys.filter((s) => s.idx >= startIdx && s.idx <= endIdx);
    if (sub.length < 2) return { error: "Need at least two surveys in the selected range." };

    const lo = Math.max(...sub.map((s) => s.depths[0]));
    const hi = Math.min(...sub.map((s) => s.depths[s.depths.length - 1]));
    if (!(lo < hi)) return { error: "The surveys in this range share no common depth range." };

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

    const first = sub[0];
    const limited = lo > first.depths[0] + 1e-9 || hi < first.depths[first.depths.length - 1] - 1e-9;
    const mergedMonths = sub.filter((s) => s.nDates > 1).map((s) => label(s.idx));

    return {
      sub, grid, gridVals, cum, maxAbs,
      T0: sub[0].idx, T1: sub[sub.length - 1].idx,
      xRange: [xmin - xpad, xmax + xpad],
      yRange: [ymax + ypad, Math.max(0, ymin - ypad)], // reversed: depth increases downward
      overlap: [lo, hi], limited, mergedMonths
    };
  }

  // Profile and cumulative net change at calendar-month time T, linearly
  // interpolated in time between the two surrounding surveys.
  function frameAt(P, T) {
    const sv = P.sub;
    const n = sv.length;
    let k, f;
    if (T <= sv[0].idx) { k = 0; f = 0; }
    else if (T >= sv[n - 1].idx) { k = n - 2; f = 1; }
    else {
      k = 0;
      while (sv[k + 1].idx < T) k++;
      f = (T - sv[k].idx) / (sv[k + 1].idx - sv[k].idx);
    }
    const a = P.gridVals[k], b = P.gridVals[k + 1];
    const vals = a.map((v, i) => v + (b[i] - v) * f);
    const net = P.cum[k] + (P.cum[k + 1] - P.cum[k]) * f;
    return { vals, net };
  }

  // ---------- shading (colour ramp by local difference) ----------

  function rampColor(bin) {
    // bin: -5..-1 (drier) or 1..5 (wetter); darker = larger difference
    const u = (Math.abs(bin) - 1) / 4;
    const lerp = (a, b) => Math.round(a + (b - a) * u);
    const c = bin > 0
      ? [lerp(190, 20), lerp(220, 90), lerp(245, 170)]   // light blue -> deep blue
      : [lerp(245, 160), lerp(215, 60), lerp(190, 20)];  // light rust -> deep rust
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.6)`;
  }

  function binOf(mean, maxAbs) {
    if (Math.abs(mean) < maxAbs * 1e-6) return 0;
    const lvl = Math.min(5, Math.max(1, Math.ceil(Math.abs(mean) / maxAbs * 5 - 1e-9)));
    return mean > 0 ? lvl : -lvl;
  }

  // Shapes between `a` (initial) and `b` (current) over the grid, with the
  // exact zero-crossings inserted so every interval has one sign. Adjacent
  // intervals with the same colour level are merged into one polygon.
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
      shapes.push({
        type: "path", path: parts.join(" "), xref: "x", yref: "y",
        fillcolor: rampColor(run.bin), line: { width: 0 }, layer: "below"
      });
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

  // ---------- figures ----------

  const dateStr = (idx) => new Date(Date.UTC(Math.floor(idx / 12), idx % 12, 1)).toISOString().slice(0, 10);

  function dateOfT(T) {
    const base = Math.floor(T + 1e-9);
    const f = Math.min(1, Math.max(0, T - base));
    const y = Math.floor(base / 12), m = base % 12;
    const t0 = Date.UTC(y, m, 1), t1 = Date.UTC(y, m + 1, 1);
    return new Date(t0 + f * (t1 - t0)).toISOString();
  }

  function initFigures() {
    const P = S.P;
    const first = P.sub[0];
    const cfg = { responsive: true, displaylogo: false };

    const colorbar = {
      x: [P.xRange[0]], y: [P.yRange[1]], mode: "markers", type: "scatter",
      showlegend: false, hoverinfo: "skip",
      marker: {
        color: [0], opacity: 0, size: 1,
        colorscale: [[0, "rgb(160,60,20)"], [0.5, "rgb(255,255,255)"], [1, "rgb(20,90,170)"]],
        cmin: -P.maxAbs, cmax: P.maxAbs, showscale: true,
        colorbar: { title: { text: "\u0394\u03b8" }, thickness: 12, len: 0.55, x: 1.02 }
      }
    };

    Plotly.newPlot("tsProfile", [
      {
        x: first.values, y: first.depths, mode: "lines+markers", name: `Start: ${label(first.idx)}`,
        line: { color: "#1E2624", width: 2.5 }, marker: { size: 5 }
      },
      {
        x: P.gridVals[0], y: P.grid, mode: "lines", name: "Now",
        line: { color: "#2F6F62", width: 2.5 }
      },
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
    Plotly.newPlot("tsTime", [
      {
        type: "bar", x: P.sub.slice(1).map((s) => dateStr(s.idx)), y: steps,
        name: "Change since previous survey",
        marker: { color: steps.map((v) => (v >= 0 ? "rgba(74,144,194,0.45)" : "rgba(164,85,46,0.45)")) }
      },
      {
        x: P.sub.map((s) => dateStr(s.idx)), y: cumMm, mode: "lines+markers",
        name: "Net change vs start", line: { color: "#1E2624", width: 2 }, marker: { size: 6 }
      },
      {
        x: [dateStr(P.T0)], y: [0], mode: "markers", name: "Now",
        marker: { size: 12, color: "#2F6F62", line: { color: "#FFFFFF", width: 2 } }
      }
    ], {
      title: { text: "Moisture difference through time", font: { size: 14 } },
      xaxis: { type: "date" },
      yaxis: { title: "\u0394 moisture (mm)", zeroline: true },
      font: { family: "IBM Plex Sans", color: "#1E2624" },
      plot_bgcolor: "#FFFFFF", paper_bgcolor: "#FFFFFF",
      margin: { t: 50, r: 30, l: 70, b: 50 },
      legend: { orientation: "h", y: -0.2 }
    }, cfg);
  }

  function signed(v) {
    return (v >= 0 ? "+" : "") + v.toFixed(2);
  }

  function render(T) {
    const P = S.P;
    if (!P) return;
    const fr = frameAt(P, T);
    const sh = buildShading(P.grid, P.gridVals[0], fr.vals, P.maxAbs);
    const nowLabel = label(Math.floor(T + 1e-9));

    Plotly.restyle("tsProfile", { x: [fr.vals], y: [P.grid], name: [`Now: ${nowLabel}`] }, [1]);
    Plotly.relayout("tsProfile", { shapes: sh.shapes });
    Plotly.restyle("tsTime", { x: [[dateOfT(T)]], y: [[fr.net * 1000]] }, [2]);

    const crossed = Math.abs(sh.total - Math.abs(sh.net)) > 1e-9 * Math.max(1, sh.total);
    $("tsReadout").textContent =
      `${label(P.T0)} \u2192 ${label(P.T1)}  |  now ${nowLabel}  |  net change vs start ${signed(sh.net * 1000)} mm` +
      (crossed ? `  |  total area ${(sh.total * 1000).toFixed(2)} mm` : "");

    $("tsScrub").value = String(Math.round(((T - P.T0) / (P.T1 - P.T0)) * 1000));
  }

  // ---------- animation ----------

  function setPlayLabel() {
    const P = S.P;
    $("tsPlayBtn").textContent = S.playing ? "Pause" : (P && S.T >= P.T1 - 1e-9 ? "Replay" : "Play");
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
    S.T = Math.min(S.P.T1, S.T + dt * S.speed);

    const done = S.T >= S.P.T1 - 1e-9;
    if (done || ts - S.lastRender >= 33) {
      render(S.T);
      S.lastRender = ts;
    }
    if (done) pause();
    else S.raf = requestAnimationFrame(tick);
  }

  // ---------- selection / setup ----------

  // ---- start / end pickers (month + year, limited to months with data) ----

  function yearsAvailable() {
    return [...new Set(S.surveys.map((s) => Math.floor(s.idx / 12)))].sort((a, b) => b - a);
  }

  function monthsAvailable(year) {
    return S.surveys.filter((s) => Math.floor(s.idx / 12) === year).map((s) => s.idx % 12);
  }

  function fillMonths(which, wantMonth) {
    const year = parseInt($(`ts${which}Year`).value, 10);
    const ms = monthsAvailable(year);
    const pick = ms.includes(wantMonth)
      ? wantMonth
      : ms.reduce((best, m) => (Math.abs(m - wantMonth) < Math.abs(best - wantMonth) ? m : best), ms[0]);
    $(`ts${which}Month`).innerHTML = ms.map((m) => `<option value="${m}">${MONTHS[m]}</option>`).join("");
    $(`ts${which}Month`).value = String(pick);
  }

  function fillEndpoint(which, idx) {
    const ySel = $(`ts${which}Year`);
    ySel.innerHTML = yearsAvailable().map((y) => `<option value="${y}">${y}</option>`).join("");
    ySel.value = String(Math.floor(idx / 12));
    fillMonths(which, idx % 12);
  }

  function readEndpoint(which) {
    return parseInt($(`ts${which}Year`).value, 10) * 12 + parseInt($(`ts${which}Month`).value, 10);
  }

  // Map the requested range onto this hole's surveys: first survey on/after the
  // requested start, last survey on/before the requested end.
  function resolveRange() {
    const sv = S.surveys;
    const start = sv.find((s) => s.idx >= S.reqStart) || sv[0];
    let end = null;
    sv.forEach((s) => { if (s.idx <= S.reqEnd) end = s; });
    end = end || sv[sv.length - 1];
    const adjusted = start.idx !== S.reqStart || (isFinite(S.reqEnd) && end.idx !== S.reqEnd);
    return { start: start.idx, end: end.idx, adjusted };
  }

  function clearFigures(message) {
    pause();
    S.P = null;
    try { Plotly.purge("tsProfile"); Plotly.purge("tsTime"); } catch (e) { /* nothing plotted yet */ }
    $("tsReadout").textContent = "";
    $("tsNote").textContent = message || "";
  }

  function setup(extraNotes) {
    pause();
    const startIdx = readEndpoint("Start");
    const endIdx = readEndpoint("End");

    if (!S.surveys.length) return clearFigures("No months with data for this hole.");
    if (endIdx === startIdx) return clearFigures("Only one month with data in this range for this hole.");
    if (endIdx < startIdx) return clearFigures("Choose an end month after the start month.");

    const P = prepare(S.surveys, startIdx, endIdx);
    if (P.error) return clearFigures(P.error);

    S.P = P;
    S.T = P.T0;

    const notes = extraNotes ? [...extraNotes] : [];
    if (P.limited) notes.push(`Depth range limited to the overlap of all surveys: ${P.overlap[0].toFixed(2)}\u2013${P.overlap[1].toFixed(2)} m.`);
    if (P.mergedMonths.length) {
      const shown = P.mergedMonths.slice(0, 4).join(", ");
      const more = P.mergedMonths.length > 4 ? ` +${P.mergedMonths.length - 4} more` : "";
      notes.push(`Readings from more than one visit date were averaged in: ${shown}${more}.`);
    }
    $("tsNote").textContent = notes.join(" ");

    initFigures();
    render(S.T);
    setPlayLabel();
  }

  function onSelectionChanged() {
    if (typeof rows === "undefined" || rows.length === 0) return clearFigures("Data not loaded yet.");
    S.surveys = buildSurveys($("siteSelect").value, $("holeSelect").value);
    if (!S.surveys.length) return clearFigures("No months with data for this hole.");
    const r = resolveRange();
    fillEndpoint("Start", r.start);
    fillEndpoint("End", r.end);
    setup(r.adjusted ? ["Range adjusted to the months with data for this hole."] : []);
  }

  function enter() {
    document.body.classList.add("tsMode");
    S.active = true;
    onSelectionChanged();
  }

  function leave() {
    pause();
    S.active = false;
    document.body.classList.remove("tsMode");
    try { Plotly.Plots.resize("plot"); } catch (e) { /* plot not drawn yet */ }
  }

  // ---------- wiring ----------

  $("modeSelect").addEventListener("change", (e) => (e.target.value === "timeseries" ? enter() : leave()));
  $("siteSelect").addEventListener("change", () => { if (S.active) onSelectionChanged(); });
  $("holeSelect").addEventListener("change", () => { if (S.active) onSelectionChanged(); });
  ["Start", "End"].forEach((which) => {
    const commit = () => {
      if (!S.active) return;
      if (which === "Start") S.reqStart = readEndpoint("Start"); else S.reqEnd = readEndpoint("End");
      setup();
    };
    $(`ts${which}Year`).addEventListener("change", () => {
      fillMonths(which, parseInt($(`ts${which}Month`).value, 10));
      commit();
    });
    $(`ts${which}Month`).addEventListener("change", commit);
  });
  $("tsPlayBtn").addEventListener("click", () => { if (S.playing) pause(); else play(); });
  $("tsRestartBtn").addEventListener("click", () => {
    if (!S.P) return;
    pause();
    S.T = S.P.T0;
    render(S.T);
    play();
  });
  $("tsScrub").addEventListener("input", () => {
    if (!S.P) return;
    pause();
    S.T = S.P.T0 + (S.P.T1 - S.P.T0) * (parseInt($("tsScrub").value, 10) / 1000);
    render(S.T);
    setPlayLabel();
  });

  // exposed for testing only
  window.NPTimeSeries = { buildSurveys, prepare, frameAt, buildShading, state: S, render, setup, enter, leave };
})();
