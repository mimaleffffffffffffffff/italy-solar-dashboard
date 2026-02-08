// main.js

// ===== Supabase credentials =====
const SUPABASE_URL = "https://fkrmcelxtpyvnmztqkqe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrcm1jZWx4dHB5dm5tenRxa3FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMzY0MzksImV4cCI6MjA4NTcxMjQzOX0.I5BvnFvsKf5mXFRsG67uiMihj5svUIWDEh-f5LbRnoM";

// ===== Data source =====
const TABLE = "regions_solar_prod_long_geojson_web";
const COL_REGION = "region";
const COL_PERIOD = "period";      // values: annual/winter/spring/summer/autumn
const COL_VALUE  = "production";
const COL_GEOM   = "geom";

// ===== Units =====
const KWH_PER_GWH = 1_000_000;
function kwhToGwh(kwh) {
  const n = Number(kwh);
  return Number.isFinite(n) ? n / KWH_PER_GWH : NaN;
}
function formatGWh(x) {
  if (!Number.isFinite(x)) return "N/A";
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ===== Leaflet map init =====
const map = L.map("map", { preferCanvas: true }).setView([42.5, 12.5], 5);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let geoLayer = null;
let legendControl = null;
let regionLayerIndex = new Map();
let selectedRegion = "";
let allRegions = [];

// ===== DOM refs =====
const seasonSelect = document.getElementById("periodSelect"); // keep this ID
const chartHint = document.getElementById("chartHint");

const comboBtn = document.getElementById("comboBtn");
const comboLabel = document.getElementById("comboLabel");
const comboPanel = document.getElementById("comboPanel");
const comboSearch = document.getElementById("comboSearch");
const comboList = document.getElementById("comboList");

// ===== Chart =====
let top5Chart = null;

// ===== Performance cache + abort =====
const seasonCache = new Map(); // season -> { rows, features, breaks }
let fetchAbortController = null;
let lastSeasonRendered = null;
let didInitialFit = false;

// ===== Helpers =====
function toFeature(row) {
  if (!row[COL_GEOM]) return null;
  const gwh = kwhToGwh(row[COL_VALUE]);

  return {
    type: "Feature",
    geometry: row[COL_GEOM],
    properties: {
      region: row[COL_REGION],
      period: row[COL_PERIOD],
      value_gwh: gwh
    }
  };
}

function quantileBreaks(values, k = 5) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const breaks = [];
  for (let i = 1; i < k; i++) {
    breaks.push(v[Math.floor((i / k) * (v.length - 1))]);
  }
  return breaks;
}

function getColor(val, breaks) {
  const colors = ["#edf8fb", "#b3cde3", "#8c96c6", "#8856a7", "#810f7c"];
  if (!Number.isFinite(val) || breaks.length < 4) return "#ccc";
  if (val <= breaks[0]) return colors[0];
  if (val <= breaks[1]) return colors[1];
  if (val <= breaks[2]) return colors[2];
  if (val <= breaks[3]) return colors[3];
  return colors[4];
}

// ===== Supabase fetch (cached + abortable) =====
async function fetchRows(season) {
  const cached = seasonCache.get(season);
  if (cached?.rows) return cached.rows;

  if (fetchAbortController) fetchAbortController.abort();
  fetchAbortController = new AbortController();

  const url =
    `${SUPABASE_URL}/rest/v1/${TABLE}` +
    `?select=${COL_REGION},${COL_PERIOD},${COL_VALUE},${COL_GEOM}` +
    `&${COL_PERIOD}=eq.${season}`;

  const res = await fetch(url, {
    signal: fetchAbortController.signal,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });

  if (!res.ok) throw new Error(`Supabase fetch failed (${res.status})`);

  const rows = await res.json();
  seasonCache.set(season, { rows });
  return rows;
}

// ===== Legend =====
function addLegend(breaks) {
  if (legendControl) legendControl.remove();

  legendControl = L.control({ position: "bottomright" });
  legendControl.onAdd = () => {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `<div class="legendTitle">
      Solar production by region (GWh, quantile classes)
    </div>`;

    const colors = ["#edf8fb", "#b3cde3", "#8c96c6", "#8856a7", "#810f7c"];
    breaks.forEach((b, i) => {
      const next = breaks[i + 1];
      const label = next
        ? `${formatGWh(b)} – ${formatGWh(next)}`
        : `> ${formatGWh(b)}`;

      div.innerHTML += `
        <div class="legendRow">
          <span class="swatch" style="background:${colors[i]}"></span>
          <span>${label} GWh</span>
        </div>`;
    });

    return div;
  };
  legendControl.addTo(map);
}

// ===== Chart =====
function updateChart(features, season) {
  const ctx = document.getElementById("top5Chart");

  const sorted = features
    .slice()
    .sort((a, b) => b.properties.value_gwh - a.properties.value_gwh)
    .slice(0, 5);

  chartHint.textContent = selectedRegion
    ? `Season: ${season} • Zoom: ${selectedRegion}`
    : `Season: ${season}`;

  if (top5Chart) top5Chart.destroy();

  top5Chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: sorted.map(f => f.properties.region),
      datasets: [{
        data: sorted.map(f => f.properties.value_gwh)
      }]
    },
    options: {
      animation: false, // small speed boost
      plugins: { legend: { display: false } },
      scales: {
        y: { title: { display: true, text: "GWh" } }
      }
    }
  });
}

// ===== Region dropdown =====
function openCombo() {
  comboPanel.classList.add("open");
  comboSearch.value = "";
  renderComboList("");
  comboSearch.focus();
}
function closeCombo() {
  comboPanel.classList.remove("open");
}

function renderComboList(filter) {
  const f = filter.toLowerCase();
  comboList.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = "comboItem" + (selectedRegion === "" ? " active" : "");
  allItem.textContent = "All regions";
  allItem.onclick = () => {
    selectedRegion = "";
    comboLabel.textContent = "All regions";
    closeCombo();
    if (geoLayer) map.fitBounds(geoLayer.getBounds(), { animate: false });
  };
  comboList.appendChild(allItem);

  allRegions
    .filter(r => r.toLowerCase().includes(f))
    .forEach(r => {
      const item = document.createElement("div");
      item.className = "comboItem" + (r === selectedRegion ? " active" : "");
      item.textContent = r;
      item.onclick = () => {
        selectedRegion = r;
        comboLabel.textContent = r;
        closeCombo();
        const lyr = regionLayerIndex.get(r);
        if (lyr) map.fitBounds(lyr.getBounds(), { animate: false });
      };
      comboList.appendChild(item);
    });
}

// ===== Draw season (separated for caching) =====
function drawSeason(features, breaks, season) {
  allRegions = [...new Set(features.map(f => f.properties.region))].sort();

  if (geoLayer) map.removeLayer(geoLayer);
  regionLayerIndex.clear();

  geoLayer = L.geoJSON(features, {
    style: f => ({
      weight: 1,
      color: "#444",
      fillOpacity: 0.75,
      fillColor: getColor(f.properties.value_gwh, breaks)
    }),
    onEachFeature: (f, layer) => {
      regionLayerIndex.set(f.properties.region, layer);
      layer.bindPopup(`
        <b>${f.properties.region}</b><br/>
        Season: ${f.properties.period}<br/>
        Production: ${formatGWh(f.properties.value_gwh)} GWh
      `);
    }
  }).addTo(map);

  addLegend(breaks);
  updateChart(features, season);

  // Fit only on first render or real season change
  if (!didInitialFit || lastSeasonRendered !== season) {
    map.fitBounds(geoLayer.getBounds(), { animate: false });
    didInitialFit = true;
    lastSeasonRendered = season;
  }
}

// ===== Main render (cached) =====
async function renderSeason(season) {
  const cached = seasonCache.get(season);
  if (cached?.features && cached?.breaks) {
    drawSeason(cached.features, cached.breaks, season);
    return;
  }

  let rows;
  try {
    rows = await fetchRows(season);
  } catch (err) {
    if (err.name === "AbortError") return; // user changed quickly
    console.error(err);
    alert("Data loading failed. Open console for details.");
    return;
  }

  const features = rows.map(toFeature).filter(Boolean);
  const values = features.map(f => f.properties.value_gwh);
  const breaks = quantileBreaks(values);

  seasonCache.set(season, { rows, features, breaks });
  drawSeason(features, breaks, season);
}

// ===== UI EVENTS =====
seasonSelect.addEventListener("change", () => {
  // changing season resets region zoom selection (optional but cleaner)
  selectedRegion = "";
  comboLabel.textContent = "All regions";
  renderSeason(seasonSelect.value);
});

comboBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  comboPanel.classList.contains("open") ? closeCombo() : openCombo();
});

comboPanel.addEventListener("click", (e) => e.stopPropagation());

comboSearch.addEventListener("input", () => {
  renderComboList(comboSearch.value);
});

document.addEventListener("click", () => closeCombo());

// ===== START =====
comboLabel.textContent = "All regions";
renderSeason(seasonSelect.value);

