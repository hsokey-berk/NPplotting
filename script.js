// ---- State ----
let rows = [];               // parsed + typed data rows (subset of columns, used for plotting)
let rawRows = [];            // every column, unfiltered — used for "view CSV" tables
let rawHeaders = [];
let lastPlottedRawRows = []; // raw rows behind whatever is currently on the graph
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

// Expect month/day/year, e.g. "8/5/2026" or "08/05/2026"
function parseDateMDY(str) {
  const parts = str.split(/[\/\-]/);
  if (parts.length !== 3) return null;
  const month = parseInt(parts[0], 10);
  const day = parseInt(parts[1], 10);
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;
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
  const site = el("siteSelect").value;
  const hole = el("holeSelect").value;
  const subset = rows.filter((r) => r.site === site && r.holeId === hole);

  const years = [...new Set(subset.map((r) => r.date.year))].sort((a, b) => b - a);
  fillSelect(el("yearSelect"), years);

  // Default to the most recent (year, month) that actually has data,
  // rather than letting Year default to the newest year but Month
  // default to January.
  let latest = null;
  subset.forEach((r) => {
    if (!latest || r.date.year > latest.year || (r.date.year === latest.year && r.date.month > latest.month)) {
      latest = { year: r.date.year, month: r.date.month };
    }
  });
  if (latest) {
    el("yearSelect").value = latest.year;
    el("monthSelect").value = latest.month;
  }

  onPrimaryChange();

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

// Rebuild the "compare against" checkbox list: every (year, month) that
// actually has data for the chosen Site + Hole ID, excluding whichever
// (year, month) is currently selected as the primary series.
//
// Preserves the previous checked state across rebuilds (e.g. switching
// Hole ID): if "select all" was checked, the new list is fully checked
// too; otherwise, any individually-checked month/year is re-checked only
// if it still exists for the new selection — if it doesn't, it's simply
// not offered (which is the "unchecks if no data available" behavior).
function onPrimaryChange() {
  const site = el("siteSelect").value;
  const hole = el("holeSelect").value;
  const primaryYear = parseInt(el("yearSelect").value, 10);
  const primaryMonth = parseInt(el("monthSelect").value, 10);

  const wasSelectAll = el("selectAllCompare").checked;
  const previouslyChecked = new Set(
    [...document.querySelectorAll(".compareCb:checked")].map((cb) => cb.value)
  );

  const combosSet = new Set();
  rows
    .filter((r) => r.site === site && r.holeId === hole)
    .forEach((r) => combosSet.add(r.date.year + "-" + r.date.month));

  const combos = [...combosSet]
    .map((s) => s.split("-").map(Number))
    .filter(([y, m]) => !(y === primaryYear && m === primaryMonth))
    .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));

  renderCompareChecks(combos, { wasSelectAll, previouslyChecked });
}

function renderCompareChecks(combos, prevState = {}) {
  const { wasSelectAll = false, previouslyChecked = new Set() } = prevState;
  const container = el("compareChecks");
  container.innerHTML = "";

  if (combos.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No other months available for this hole.";
    container.appendChild(p);
    el("selectAllCompare").checked = false;
    el("selectAllCompare").disabled = true;
    return;
  }

  el("selectAllCompare").disabled = false;
  el("selectAllCompare").checked = wasSelectAll;

  combos.forEach(([y, m]) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = `${y}-${m}`;
    cb.className = "compareCb";
    cb.checked = wasSelectAll || previouslyChecked.has(cb.value);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`${monthName(m)} ${y}`));
    container.appendChild(label);
  });
}

function onSelectAllChange() {
  const checked = el("selectAllCompare").checked;
  document.querySelectorAll(".compareCb").forEach((cb) => (cb.checked = checked));
}

// ---- Build (year, month) combos to plot ----

function buildCombos() {
  const primaryYear = parseInt(el("yearSelect").value, 10);
  const primaryMonth = parseInt(el("monthSelect").value, 10);

  const combos = [[primaryYear, primaryMonth]];

  document.querySelectorAll(".compareCb:checked").forEach((cb) => {
    const [y, m] = cb.value.split("-").map(Number);
    combos.push([y, m]);
  });

  return combos;
}

// ---- Plot ----

function plot() {
  const site = el("siteSelect").value;
  const hole = el("holeSelect").value;
  const unit = el("unitSelect").value;
  const combos = buildCombos();

  const traces = [];
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
    const neutronVals = subset.map((r) => r.neutron);

    traces.push({
      x: neutronVals,
      y: cableVals,
      mode: "lines+markers",
      name: monthName(mo) + " " + yr,
      line: { color: seriesColors[i % seriesColors.length], width: 2 },
      marker: { size: 6 }
    });
  });

  if (traces.length === 0) {
    setStatus("No data found for that Site / Hole ID / date selection.", true);
    Plotly.purge("plot");
    return;
  }

  const unitLabel = unit === "m" ? "Cable length (m)" : "Cable length (ft)";

  const layout = {
    title: {
      text: `${site} \u2014 Hole ${hole} \u2014 Neutron Count vs Cable Length`,
      font: { family: "IBM Plex Sans", size: 16 },
      y: 0.98,
      yanchor: "top"
    },
    xaxis: { title: { text: "Neutron Count (MD)", standoff: 8 }, side: "top" },
    yaxis: { title: unitLabel, autorange: "reversed" },
    font: { family: "IBM Plex Sans", color: "#1E2624" },
    plot_bgcolor: "#FFFFFF",
    paper_bgcolor: "#FFFFFF",
    margin: { t: 100, r: 30, l: 60, b: 40 },
    legend: { orientation: "h", y: -0.12 }
  };

  Plotly.newPlot("plot", traces, layout, { responsive: true, displaylogo: false });

  lastPlottedRawRows = plottedRawRows;

  setStatus(skipped.length ? `No data for: ${skipped.join(", ")}` : "");
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

// ---- CSV-as-sheet modal (paginated, so it stays smooth with 100k+ rows) ----

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

// ---- Wire up events ----

el("siteSelect").addEventListener("change", onSiteChange);
el("holeSelect").addEventListener("change", onHoleChange);
el("yearSelect").addEventListener("change", onPrimaryChange);
el("monthSelect").addEventListener("change", onPrimaryChange);
el("selectAllCompare").addEventListener("change", onSelectAllChange);
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
