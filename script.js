// ---- State ----
let rows = [];
let rawRows = [];
let rawHeaders = [];
let lastPlottedRawRows = [];
let sites = [];
let seriesColors = ["#2F6F62", "#B9863E", "#4A6B8A", "#A4552E", "#6B5B8C", "#7A8C4A"];

const el = (id) => document.getElementById(id);

// ---- Load & parse CSV ----

function loadData() {
  Papa.parse(CSV_FILENAME, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      try {
        rawRows = results.data;
        rawHeaders = results.meta && results.meta.fields ? results.meta.fields : [];
        rows = results.data.map(parseRow).filter((r) => r !== null);
        if (rows.length === 0) {
          setStatus("File loaded, but no valid rows were found — check column names match exactly.", true);
          return;
        }
        populateSiteOptions();
        el("syncStatus").textContent = `Loaded ${rows.length} rows from ${CSV_FILENAME}`;
        setStatus("");
      } catch (e) {
        setStatus("Error parsing " + CSV_FILENAME + ": " + e.message, true);
      }
    },
    error: (err) => {
      setStatus(`Could not load ${CSV_FILENAME}. Check that it's in the same folder as index.html, and that CSV_FILENAME in config.js matches the exact filename.`, true);
      console.error(err);
    }
  });
}

function parseRow(r) {
  const site = (r["Site"] || "").trim();
  const holeIdRaw = r["Hole ID"];
  const dateRaw = (r["Date"] || "").trim();
  const cableRaw = r["Cable length (ft)"];
  const neutronRaw = r["Neutron Count (MD)"];

  if (!site || !dateRaw || cableRaw === undefined || neutronRaw === undefined) return null;

  const date = parseDateMDY(dateRaw);
  if (!date) return null;

  const cable = parseFloat(cableRaw);
  const neutron = parseFloat(neutronRaw);
  const holeId = holeIdRaw !== undefined ? holeIdRaw.trim() : "";

  if (isNaN(cable) || isNaN(neutron)) return null;

  return { site, holeId, date, cableFt: cable, neutron, raw: r };
}

function parseDateMDY(str) {
  const parts = str.split(/[\/\-]/);
  if (parts.length !== 3) return null;

  let year, month, day;

  if (parts[0].length === 4) {
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else {
    month = parseInt(parts[0], 10);
    day = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;
  }

  if (!month || !day || !year || month > 12 || day > 31) return null;
  return { year, month, day };
}

// ---- Populate dropdowns from data ----

function populateSiteOptions() {
  sites = [...new Set(rows.map((r) => r.site))].sort();
  fillSelect(el("siteSelect"), sites);

  if (typeof DEFAULT_SITE !== "undefined" && sites.includes(DEFAULT_SITE)) {
    el("siteSelect").value = DEFAULT_SITE;
  }

  onSiteChange();
}

function onSiteChange() {
  const site = el("siteSelect").value;
  const holes = [...new Set(rows.filter((r) => r.site === site).map((r) => r.holeId))]
    .sort((a, b) => (isNaN(a) || isNaN(b) ? a.localeCompare(b) : a - b));
  fillSelect(el("holeSelect"), holes);
  onHoleChange();
}

function onHoleChange() {
  refreshCompareList();
  if (rows.length > 0) plot();
}

function fillSelect(selectEl, values) {
  selectEl.innerHTML = "";
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });
}

// ---- Plot-selection state ----

let allCombos = [];
let checkedCombos = new Set();

function refreshCompareList() {
  const site = el("siteSelect").value;
  const hole = el("holeSelect").value;

  const combosSet = new Set();
  rows
    .filter((r) => r.site === site && r.holeId === hole)
    .forEach((r) => combosSet.add(r.date.year + "-" + r.date.month));

  allCombos = [...combosSet]
    .map((s) => s.split("-").map(Number))
    .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));

  const validValues = new Set(allCombos.map(([y, m]) => `${y}-${m}`));
  checkedCombos = new Set([...checkedCombos].filter((v) => validValues.has(v)));

  if (checkedCombos.size === 0 && allCombos.length > 0) {
    const [y, m] = allCombos[0];
    checkedCombos.add(`${y}-${m}`);
  }

  renderFilterOptions();
  renderCompareChecks();
}

function renderFilterOptions() {
  const months = [...new Set(allCombos.map(([, m]) => m))].sort((a, b) => a - b);
  const years = [...new Set(allCombos.map(([y]) => y))].sort((a, b) => b - a);

  const monthSel = el("filterMonth");
  const prevMonth = monthSel.value;
  monthSel.innerHTML = '<option value="">All months</option>';
  months.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = monthName(m);
    monthSel.appendChild(opt);
  });
  if ([...monthSel.options].some((o) => o.value === prevMonth)) monthSel.value = prevMonth;

  const yearSel = el("filterYear");
  const prevYear = yearSel.value;
  yearSel.innerHTML = '<option value="">All years</option>';
  years.forEach((y) => {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    yearSel.appendChild(opt);
  });
  if ([...yearSel.options].some((o) => o.value === prevYear)) yearSel.value = prevYear;
}

function getVisibleCombos() {
  const monthFilter = el("filterMonth").value;
  const yearFilter = el("filterYear").value;
  return allCombos.filter(([y, m]) => {
    if (monthFilter && m !== parseInt(monthFilter, 10)) return false;
    if (yearFilter && y !== parseInt(yearFilter, 10)) return false;
    return true;
  });
}

function renderCompareChecks() {
  const container = el("compareChecks");
  container.innerHTML = "";

  if (allCombos.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No other months available for this hole.";
    container.appendChild(p);
    return;
  }

  const visible = getVisibleCombos();

  if (visible.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No months match this filter.";
    container.appendChild(p);
    return;
  }

  visible.forEach(([y, m]) => {
    const value = `${y}-${m}`;
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = value;
    cb.className = "compareCb";
    cb.checked = checkedCombos.has(value);
    cb.addEventListener("change", () => {
      if (cb.checked) checkedCombos.add(value);
      else checkedCombos.delete(value);
      if (rows.length > 0) plot();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`${monthName(m)} ${y}`));
    container.appendChild(label);
  });
}

function onFilterChange() {
  renderCompareChecks();
}

function selectAllVisible() {
  getVisibleCombos().forEach(([y, m]) => checkedCombos.add(`${y}-${m}`));
  renderCompareChecks();
  if (rows.length > 0) plot();
}

function clearAllCompare() {
  checkedCombos.clear();
  renderCompareChecks();
  if (rows.length > 0) plot();
}

// ---- Build combos to plot ----

function buildCombos() {
  const combos = [];
  checkedCombos.forEach((value) => {
    const [y, m] = value.split("-").map(Number);
    combos.push([y, m]);
  });
  return combos;
}

// ---- Plot ----

function plot() {
  const site = el("siteSelect").value;
  const hole = el("holeSelect").value;
  const unit = el("unitSelect").value;
  const countUnit = el("countUnitSelect").value;
  const combos = buildCombos();

  el("shadeAreaField").hidden = combos.length !== 2;

  if (combos.length === 0) {
    setStatus("Select at least one month to plot.", true);
    Plotly.purge("plot");
    el("areaResult").hidden = true;
    return;
  }

  const traces = [];
  const seriesData = [];
  const skipped = [];
  const plottedRawRows = [];

  combos.forEach(([yr, mo], i) => {
    const subset = rows
      .filter((r) => r.site === site && r.holeId === hole && r.date.year === yr && r.date.month === mo)
      .sort((a, b) => a.cableFt - b.cableFt);

    if (subset.length === 0) {
      skipped.push(monthName(mo) + " " + yr);
      return;
    }

    subset.forEach((r) => plottedRawRows.push(r.raw));

    const cableVals = subset.map((r) => (unit === "m" ? r.cableFt * 0.3048 : r.cableFt));
    const countVals = subset.map((r) =>
      countUnit === "theta" ? THETA_SLOPE * r.neutron + THETA_INTERCEPT : r.neutron
    );

    traces.push({
      x: countVals,
      y: cableVals,
      mode: "lines+markers",
      name: monthName(mo) + " " + yr,
      line: { color: seriesColors[i % seriesColors.length], width: 2 },
      marker: { size: 6 }
    });

    seriesData.push({ yr, mo, depths: cableVals, values: countVals });
  });

  if (traces.length === 0) {
    setStatus("No data found for that Site / Hole ID / date selection.", true);
    Plotly.purge("plot");
    el("areaResult").hidden = true;
    return;
  }

  const unitLabel = unit === "m" ? "Cable length (m)" : "Cable length (ft)";
  const countLabel = countUnit === "theta" ? "Theta" : "Neutron Count (MD)";

  const layout = {
    title: {
      text: `${site} \u2014 Hole ${hole} \u2014 ${countLabel} vs Cable Length`,
      font: { family: "IBM Plex Sans", size: 16 },
      y: 0.98,
      yanchor: "top"
    },
    xaxis: { title: { text: countLabel, standoff: 8 }, side: "top" },
    yaxis: { title: unitLabel, autorange: "reversed" },
    font: { family: "IBM Plex Sans", color: "#1E2624" },
    plot_bgcolor: "#FFFFFF",
    paper_bgcolor: "#FFFFFF",
    margin: { t: 100, r: 30, l: 60, b: 40 },
    legend: { orientation: "h", y: -0.12 }
  };

  Plotly.newPlot("plot", traces, layout, { responsive: true, displaylogo: false });

  lastPlottedRawRows = plottedRawRows;

  updateAreaResult(seriesData, unit, countUnit);

  setStatus(skipped.length ? `No data for: ${skipped.join(", ")}` : "");
}

// ---- Area between two curves ----

function interpAt(depths, values, target) {
  if (target < depths[0] || target > depths[depths.length - 1]) return null;
  for (let i = 0; i < depths.length - 1; i++) {
    if (target >= depths[i] && target <= depths[i + 1]) {
      if (depths[i + 1] === depths[i]) return values[i];
      const t = (target - depths[i]) / (depths[i + 1] - depths[i]);
      return values[i] + t * (values[i + 1] - values[i]);
    }
  }
  return values[values.length - 1];
}

function trapz(xs, ys) {
  let total = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    total += 0.5 * (ys[i] + ys[i + 1]) * (xs[i + 1] - xs[i]);
  }
  return total;
}

function updateAreaResult(seriesData, unit, countUnit) {
  const box = el("areaResult");
  const enabled = el("shadeAreaCheckbox").checked;

  if (!enabled) {
    box.hidden = true;
    box.innerHTML = "";
    clearAreaShading();
    return;
  }

  if (seriesData.length !== 2) {
    box.hidden = true;
    box.innerHTML = "";
    clearAreaShading();
    return;
  }

  const [a, b] = [...seriesData].sort((s1, s2) => (s1.yr - s2.yr) || (s1.mo - s2.mo));

  if (a.depths.length < 2 || b.depths.length < 2) {
    box.hidden = false;
    box.innerHTML = `<h3>Moisture difference</h3><p class="metric-label">Not enough data points in one of the two series to integrate.</p>`;
    clearAreaShading();
    return;
  }

  const loStart = Math.max(a.depths[0], b.depths[0]);
  const hiEnd = Math.min(a.depths[a.depths.length - 1], b.depths[b.depths.length - 1]);

  if (loStart >= hiEnd) {
    box.hidden = false;
    box.innerHTML = `<h3>Moisture difference</h3><p class="metric-label">These two series don't overlap in cable length, so an area can't be computed.</p>`;
    clearAreaShading();
    return;
  }

  const mergedDepths = [...new Set([
    loStart, hiEnd,
    ...a.depths.filter((d) => d >= loStart && d <= hiEnd),
    ...b.depths.filter((d) => d >= loStart && d <= hiEnd)
  ])].sort((x, y) => x - y);

  const diffs = mergedDepths.map((d) => interpAt(b.depths, b.values, d) - interpAt(a.depths, a.values, d));

  const refinedDepths = [mergedDepths[0]];
  const refinedDiffs = [diffs[0]];
  for (let i = 0; i < mergedDepths.length - 1; i++) {
    const d0 = mergedDepths[i], d1 = mergedDepths[i + 1];
    const v0 = diffs[i], v1 = diffs[i + 1];
    if ((v0 > 0 && v1 < 0) || (v0 < 0 && v1 > 0)) {
      const t = v0 / (v0 - v1);
      refinedDepths.push(d0 + t * (d1 - d0));
      refinedDiffs.push(0);
    }
    refinedDepths.push(d1);
    refinedDiffs.push(v1);
  }

  const aValsRefined = refinedDepths.map((d) => interpAt(a.depths, a.values, d));
  const bValsRefined = refinedDepths.map((d) => interpAt(b.depths, b.values, d));

  drawAreaShading(refinedDepths, refinedDiffs, aValsRefined, bValsRefined);

  const netChange = trapz(refinedDepths, refinedDiffs);
  const totalArea = trapz(refinedDepths, refinedDiffs.map(Math.abs));

  const depthUnitLabel = unit === "m" ? "m" : "ft";
  const areaUnitLabel = countUnit === "theta" ? `${depthUnitLabel}` : `count\u00b7${depthUnitLabel}`;

  const earlierLabel = `${monthName(a.mo)} ${a.yr}`;
  const laterLabel = `${monthName(b.mo)} ${b.yr}`;
  const direction = netChange > 0 ? "increase" : netChange < 0 ? "decrease" : "no change";

  const curvesCrossed = Math.abs(totalArea - Math.abs(netChange)) > 1e-9 * Math.max(1, totalArea);

  const netChangeMm = countUnit === "theta" ? (netChange * 1000).toFixed(2) + "mm" : "";
  const totalAreaMm = countUnit === "theta" ? (totalArea * 1000).toFixed(2) + "mm" : "";

  const netMmSpan = netChangeMm ? ` <span class="metric-label">/ </span><span class="metric">${netChangeMm}</span>` : "";
  const totalMmSpan = totalAreaMm && curvesCrossed ? ` <span class="metric-label">/ </span><span class="metric">${totalAreaMm}</span>` : "";

  const totalAreaLine = curvesCrossed
    ? `<div><span class="metric-label">Total area between curves: </span><span class="metric">${totalArea.toFixed(5)}${areaUnitLabel}</span>${totalMmSpan}</div>`
    : "";

  box.hidden = false;
  box.innerHTML = `
    <h3>Moisture difference: ${earlierLabel} \u2192 ${laterLabel}</h3>
    <div><span class="metric-label">Net change: </span><span class="metric">${netChange.toFixed(5)}${areaUnitLabel}</span>${netMmSpan} <span class="metric-label">(${direction})</span></div>
    ${totalAreaLine}
  `;
}

function clearAreaShading() {
  Plotly.relayout("plot", { shapes: [] });
}

function drawAreaShading(depths, diffs, aVals, bVals) {
  const shapes = [];

  for (let i = 0; i < depths.length - 1; i++) {
    const sign = diffs[i] + diffs[i + 1];
    if (sign === 0) continue;

    const color = sign > 0 ? "rgba(74, 144, 194, 0.28)" : "rgba(164, 85, 46, 0.28)";

    const path = [
      `M ${aVals[i]},${depths[i]}`,
      `L ${aVals[i + 1]},${depths[i + 1]}`,
      `L ${bVals[i + 1]},${depths[i + 1]}`,
      `L ${bVals[i]},${depths[i]}`,
      "Z"
    ].join(" ");

    shapes.push({
      type: "path",
      path,
      xref: "x",
      yref: "y",
      fillcolor: color,
      line: { width: 0 },
      layer: "below"
    });
  }

  Plotly.relayout("plot", { shapes });
}

function monthName(m) {
  return ["", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"][m];
}

function setStatus(msg, isError = false) {
  const note = el("statusNote");
  note.textContent = msg;
  note.classList.toggle("error", isError);
}

// ---- CSV modal ----

const PAGE_SIZE = 250;
let modalDataset = [];
let modalPage = 0;

function openFullCsvModal() {
  if (rawRows.length === 0) {
    setStatus("No data loaded yet — nothing to show.", true);
    return;
  }
  openModal(rawRows, CSV_FILENAME);
}

function openPlottedCsvModal() {
  if (lastPlottedRawRows.length === 0) {
    setStatus("Nothing plotted yet — click Plot first.", true);
    return;
  }
  openModal(lastPlottedRawRows, "Currently plotted rows");
}

function openModal(dataset, label) {
  modalDataset = dataset;
  modalPage = 0;
  el("csvModalTitle").textContent = label;
  renderModalPage();
  el("csvModal").hidden = false;
}

function closeCsvModal() {
  el("csvModal").hidden = true;
}

function renderModalPage() {
  const total = modalDataset.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  modalPage = Math.min(Math.max(modalPage, 0), totalPages - 1);

  const start = modalPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  const pageRows = modalDataset.slice(start, end);

  const headers = rawHeaders.length ? rawHeaders : Object.keys(modalDataset[0] || {});

  const table = el("csvTable");
  table.innerHTML = "";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  pageRows.forEach((row) => {
    const tr = document.createElement("tr");
    headers.forEach((h) => {
      const td = document.createElement("td");
      td.textContent = row[h] !== undefined && row[h] !== null ? row[h] : "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  el("csvPageInfo").textContent =
    total === 0 ? "No rows" : `Rows ${start + 1}\u2013${end} of ${total} \u00b7 page ${modalPage + 1} of ${totalPages}`;
  el("csvPrevBtn").disabled = modalPage === 0;
  el("csvNextBtn").disabled = modalPage >= totalPages - 1;
}

function csvPrevPage() {
  modalPage -= 1;
  renderModalPage();
}

function csvNextPage() {
  modalPage += 1;
  renderModalPage();
}

// ---- Events ----

el("siteSelect").addEventListener("change", onSiteChange);
el("holeSelect").addEventListener("change", onHoleChange);
el("unitSelect").addEventListener("change", () => { if (rows.length > 0) plot(); });
el("countUnitSelect").addEventListener("change", () => { if (rows.length > 0) plot(); });
el("shadeAreaCheckbox").addEventListener("change", (e) => {
  if (e.target.checked) {
    el("unitSelect").value = "m";
    el("countUnitSelect").value = "theta";
  }
  if (rows.length > 0) plot();
});
el("filterMonth").addEventListener("change", onFilterChange);
el("filterYear").addEventListener("change", onFilterChange);
el("selectAllVisibleBtn").addEventListener("click", selectAllVisible);
el("clearCompareBtn").addEventListener("click", clearAllCompare);
el("plotBtn").addEventListener("click", plot);
el("viewFullCsvBtn").addEventListener("click", openFullCsvModal);
el("viewPlottedCsvBtn").addEventListener("click", openPlottedCsvModal);
el("closeCsvModal").addEventListener("click", closeCsvModal);
el("csvPrevBtn").addEventListener("click", csvPrevPage);
el("csvNextBtn").addEventListener("click", csvNextPage);
el("csvModal").addEventListener("click", (e) => {
  if (e.target.id === "csvModal") closeCsvModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("csvModal").hidden) closeCsvModal();
});

loadData();
