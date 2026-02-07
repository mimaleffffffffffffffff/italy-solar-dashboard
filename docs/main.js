// ===== Supabase credentials =====
const SUPABASE_URL = "https://fkrmcelxtpyvnmztqkqe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrcm1jZWx4dHB5dm5tenRxa3FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMzY0MzksImV4cCI6MjA4NTcxMjQzOX0.I5BvnFvsKf5mXFRsG67uiMihj5svUIWDEh-f5LbRnoM";

// ===== Data source =====
const TABLE = "regions_solar_prod_long_geojson";
const COL_REGION = "region";
const COL_PERIOD = "period";
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
const map = L.map("map").setView([42.5, 12.5], 5);

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
const seasonSelect = document.getElementById("periodSelect"); // KEEP THIS ID
const chartHint = document.getElementById("chartHint");

const comboBtn = document.getElementById("comboBtn");
const comboLabel = document.getElementById("comboLabel");
const comboPanel = document.getElementById("comboPanel");
const comboSearch = document.getElementById("comboSearch");
const comboList = document.getElementById("comboList");

// ===== Chart =====
let top5Chart = null;

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

// ===== Supabase fetch =====
async function fetchRows(season) {
  const url =
    `${SUPABASE_URL}/rest/v1/${TABLE}` +
    `?select=${COL_REGION},${COL_PERIOD},${COL_VALUE},${COL_GEOM}` +
    `&${COL_PERIOD}=eq.${season}`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });

  if (!res.ok) throw new Error("Supabase fetch failed");
  return await res.json();
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
    map.fitBounds(geoLayer.getBounds());
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
        map.fitBounds(regionLayerIndex.get(r).getBounds());
      };
      comboList.appendChild(item);
    });
}

// ===== Main render =====
async function renderSeason(season) {
  const rows = await fetchRows(season);
  const features = rows.map(toFeature).filter(Boolean);
  const values = features.map(f => f.properties.value_gwh);

  allRegions = [...new Set(features.map(f => f.properties.region))].sort();

  if (geoLayer) map.removeLayer(geoLayer);
  regionLayerIndex.clear();

  const breaks = quantileBreaks(values);

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
  map.fitBounds(geoLayer.getBounds());
}

// ===== UI EVENTS (FIXED) =====
seasonSelect.addEventListener("change", () => {
  renderSeason(seasonSelect.value);
});

comboBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  comboPanel.classList.contains("open") ? closeCombo() : openCombo();
});

comboPanel.addEventListener("click", (e) => {
  e.stopPropagation();
});

comboSearch.addEventListener("input", () => {
  renderComboList(comboSearch.value);
});

document.addEventListener("click", () => closeCombo());

// ===== START =====
comboLabel.textContent = "All regions";
renderSeason(seasonSelect.value);
