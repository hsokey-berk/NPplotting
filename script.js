// ---- State ----
let rows = [];               // parsed + typed data rows
let sites = [];
let seriesColors = ["#2F6F62", "#B9863E", "#4A6B8A", "#A4552E", "#6B5B8C", "#7A8C4A"];

const el = (id) => document.getElementById(id);

// ---- Load & parse CSV ----

function loadData() {
  if (!CSV_URL || CSV_URL.includes("PASTE_YOUR")) {
    setStatus("No sheet linked yet — edit config.js and paste your published CSV URL.", true);
    return;
  }

  Papa.parse(CSV_URL, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      try {
        rows = results.data.map(parseRow).filter((r) => r !== null);
        if (rows.length === 0) {
          setStatus("Sheet loaded, but no valid rows were found — check column names match exactly.", true);
          return;
        }
        populateSiteOptions();
        el("syncStatus").textContent = `Synced ${rows.length} rows \u00b7 ${new Date().toLocaleTimeString()}`;
        setStatus("");
      } catch (e) {
        setStatus("Error parsing sheet: " + e.message, true);
      }
    },
    error: (err) => {
      setStatus("Could not load the sheet. Check the CSV_URL in config.js and that it's published to web.", true);
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

  return { site, holeId, date, cableFt: cable, neutron };
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
  const years = [...new Set(
    rows.filter((r) => r.site === site && r.holeId === hole).map((r) => r.date.year)
  )].sort((a, b) => b - a);

  fillSelect(el("yearSelect"), years);
  fillSelect(el("compareYearSelect"), years);
  renderYearChecks(years);
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

function renderYearChecks(years) {
  const container = el("yearChecks");
  container.innerHTML = "";
  years.forEach((y) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = y;
    cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(y));
    container.appendChild(label);
  });
}

// ---- Mode switching UI ----

function onModeChange() {
  const mode = el("modeSelect").value;
  el("vsMonthFields").hidden = mode !== "vsMonth";
  el("vsYearsFields").hidden = mode !== "vsYears";
}

// ---- Build (year, month) combos per selected mode ----

function buildCombos() {
  const mode = el("modeSelect").value;
  const targetYear = parseInt(el("yearSelect").value, 10);
  const targetMonth = parseInt(el("monthSelect").value, 10);

  if (mode === "single") {
    return [[targetYear, targetMonth]];
  }

  if (mode === "vsMonth") {
    const cYear = parseInt(el("compareYearSelect").value, 10);
    const cMonth = parseInt(el("compareMonthSelect").value, 10);
    return [[targetYear, targetMonth], [cYear, cMonth]];
  }

  if (mode === "vsYears") {
    const checked = [...el("yearChecks").querySelectorAll("input:checked")]
      .map((cb) => parseInt(cb.value, 10))
      .sort((a, b) => b - a);
    return checked.map((y) => [y, targetMonth]);
  }

  return [];
}

// ---- Plot ----

function plot() {
  const site = el("siteSelect").value;
  const hole = el("holeSelect").value;
  const unit = el("unitSelect").value;
  const combos = buildCombos();

  if (combos.length === 0) {
    setStatus("No year/month combination selected.", true);
    return;
  }

  const traces = [];
  const skipped = [];

  combos.forEach(([yr, mo], i) => {
    const subset = rows
      .filter((r) => r.site === site && r.holeId === hole && r.date.year === yr && r.date.month === mo)
      .sort((a, b) => a.cableFt - b.cableFt);

    if (subset.length === 0) {
      skipped.push(monthName(mo) + " " + yr);
      return;
    }

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
    title: { text: `${site} \u2014 Hole ${hole} \u2014 Neutron Count vs Cable Length`, font: { family: "IBM Plex Sans", size: 16 } },
    xaxis: { title: "Neutron Count (MD)", side: "top" },
    yaxis: { title: unitLabel, autorange: "reversed" },
    font: { family: "IBM Plex Sans", color: "#1E2624" },
    plot_bgcolor: "#FFFFFF",
    paper_bgcolor: "#FFFFFF",
    margin: { t: 60, r: 30, l: 60, b: 40 },
    legend: { orientation: "h", y: -0.12 }
  };

  Plotly.newPlot("plot", traces, layout, { responsive: true, displaylogo: false });

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

// ---- Wire up events ----

el("siteSelect").addEventListener("change", onSiteChange);
el("holeSelect").addEventListener("change", onHoleChange);
el("modeSelect").addEventListener("change", onModeChange);
el("plotBtn").addEventListener("click", plot);

loadData();
