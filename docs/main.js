// ===== Supabase credentials =====
const SUPABASE_URL = "https://fkrmcelxtpyvnmztqkqe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrcm1jZWx4dHB5dm5tenRxa3FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMzY0MzksImV4cCI6MjA4NTcxMjQzOX0.I5BvnFvsKf5mXFRsG67uiMihj5svUIWDEh-f5LbRnoM";

// ===== Data source =====
const TABLE = "regions_solar_prod_long_geojson";
const COL_REGION = "region";
const COL_PERIOD = "period";
const COL_VALUE  = "production"; // currently in kWh
const COL_GEOM   = "geom";

// ===== Units =====
const KWH_PER_GWH = 1_000_000;
function kwhToGwh(kwh) {
  const n = Number(kwh);
  return Number.isFinite(n) ? (n / KWH_PER_GWH) : NaN;
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
let selectedRegion = ""; // "" means All
let allRegions = [];
let currentSeason = "spring";

// ===== DOM refs =====
const seasonSelect = document.getElementById("seasonSelect");
const chartHint = document.getElementById("chartHint");

// Custom dropdown refs
const comboBtn = document.getElementById("comboBtn");
const comboLabel = document.getElementById("comboLabel");
const comboPanel = document.getElementById("comboPanel");
const comboSearch = document.getElementById("comboSearch");
const comboList = document.getElementById("comboList");

// ===== Chart =====
let top5Chart = null;

// Convert row → Feature (store BOTH kWh + GWh)
function toFeature(row) {
  const geom = row[COL_GEOM];
  if (!geom) return null;

  const kwh = Number(row[COL_VALUE]);
  const gwh = kwhToGwh(kwh);

  return {
    type: "Feature",
    geometry: geom,
    properties: {
      region: row[COL_REGION],
      period: row[COL_PERIOD],
      value_kwh: kwh,
      value_gwh: gwh
    }
  };
}

// ===== Quantiles (5 classes) =====
function quantileBreaks(values, k = 5) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length === 0) return [];
  const breaks = [];
  for (let i = 1; i < k; i++) {
    const p = i / k;
    const idx = Math.floor(p * (v.length - 1));
    breaks.push(v[idx]);
  }
  return breaks;
}

function getColorByBreaks(val, breaks) {
  const colors = ["#edf8fb", "#b3cde3", "#8c96c6", "#8856a7", "#810f7c"];
  if (!Number.isFinite(val) || breaks.length < 4) return "#cccccc";
  if (val <= breaks[0]) return colors[0];
  if (val <= breaks[1]) return colors[1];
  if (val <= breaks[2]) return colors[2];
  if (val <= breaks[3]) return colors[3];
  return colors[4];
}

// ===== Supabase fetch =====
async function fetchRows(season) {
  const select = `${COL_REGION},${COL_PERIOD},${COL_VALUE},${COL_GEOM}`;
  const url =
    `${SUPABASE_URL}/rest/v1/${TABLE}` +
    `?select=${encodeURIComponent(select)}` +
    `&${COL_PERIOD}=eq.${encodeURIComponent(season)}`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase error ${res.status}: ${txt}`);
  }

  return await res.json();
}

// ===== Legend =====
function removeLegend() {
  if (legendControl) legendControl.remove();
  legendControl = null;
}

function addLegend(breaksGwh) {
  removeLegend();

  legendControl = L.control({ position: "bottomright" });
  legendControl.onAdd = function () {
    const div = L.DomUtil.create("div", "legend");

    const colors = ["#edf8fb", "#b3cde3", "#8c96c6", "#8856a7", "#810f7c"];
    const labels = [
      `≤ ${formatGWh(breaksGwh[0])} GWh`,
      `${formatGWh(breaksGwh[0])} – ${formatGWh(breaksGwh[1])} GWh`,
      `${formatGWh(breaksGwh[1])} – ${formatGWh(breaksGwh[2])} GWh`,
      `${formatGWh(breaksGwh[2])} – ${formatGWh(breaksGwh[3])} GWh`,
      `> ${formatGWh(breaksGwh[3])} GWh`
    ];

    div.innerHTML = `<div class="legendTitle">Solar production by region (GWh, quantile classes)</div>`;

    labels.forEach((lab, i) => {
      div.innerHTML += `
        <div class="legendRow">
          <span class="swatch" style="background:${colors[i]}"></span>
          <span>${lab}</span>
        </div>
      `;
    });

    return div;
  };

  legendControl.addTo(map);
}

// ===== Chart (Top 5) =====
function updateTop5Chart(features, season) {
  const canvas = document.getElementById("top5Chart");

  if (!window.Chart) {
    chartHint.textContent = "Chart.js didn't load. Check internet / CDN blocked.";
    return;
  }

  const sorted = features.slice().sort((a, b) => (b.properties.value_gwh - a.properties.value_gwh));
  const top5 = sorted.slice(0, 5);

  const labels = top5.map(f => f.properties.region);
  const values = top5.map(f => Number(f.properties.value_gwh));

  chartHint.textContent = selectedRegion
    ? `Season: ${season} • Zoom: ${selectedRegion}`
    : `Season: ${season}`;

  if (top5Chart) top5Chart.destroy();

  top5Chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: `Production (GWh • ${season})`, data: values }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${formatGWh(Number(ctx.raw))} GWh`
          }
        }
      },
      scales: {
        y: {
          title: { display: true, text: "GWh" },
          ticks: { callback: (v) => Number(v).toLocaleString() }
        }
      }
    }
  });
}

// ===== Custom dropdown (search inside dropdown) =====
function openCombo() {
  comboPanel.classList.add("open");
  comboPanel.setAttribute("aria-hidden", "false");
  comboSearch.value = "";
  renderComboList("");
  comboSearch.focus();
}
function closeCombo() {
  comboPanel.classList.remove("open");
  comboPanel.setAttribute("aria-hidden", "true");
}
function renderComboList(filterText) {
  const f = (filterText || "").trim().toLowerCase();

  const filtered = !f
    ? allRegions
    : allRegions.filter(r => r.toLowerCase().includes(f));

  comboList.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = "comboItem" + (selectedRegion === "" ? " active" : "");
  allItem.textContent = "All regions";
  allItem.addEventListener("click", () => {
    selectedRegion = "";
    comboLabel.textContent = "All regions";
    closeCombo();
    zoomToRegion("");
  });
  comboList.appendChild(allItem);

  filtered.forEach(r => {
    const item = document.createElement("div");
    item.className = "comboItem" + (selectedRegion === r ? " active" : "");
    item.textContent = r;
    item.addEventListener("click", () => {
      selectedRegion = r;
      comboLabel.textContent = r;
      closeCombo();
      zoomToRegion(r);
    });
    comboList.appendChild(item);
  });

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "comboItem";
    empty.style.color = "#777";
    empty.textContent = "No matches";
    comboList.appendChild(empty);
  }
}

function zoomToRegion(regionName) {
  if (!geoLayer) return;

  if (!regionName) {
    map.fitBounds(geoLayer.getBounds(), { padding: [10, 10] });
    return;
  }

  const layer = regionLayerIndex.get(regionName);
  if (!layer) return;

  map.fitBounds(layer.getBounds(), { padding: [20, 20] });
  layer.openPopup();
}

// ===== Main render =====
async function renderSeason(season) {
  currentSeason = season;
  console.log("Rendering season:", season);

  const rows = await fetchRows(season);
  console.log("Rows fetched:", rows.length);

  const features = rows.map(toFeature).filter(Boolean);

  const valuesGwh = features.map(f => Number(f.properties.value_gwh)).filter(Number.isFinite);

  if (valuesGwh.length === 0) {
    if (geoLayer) map.removeLayer(geoLayer);
    geoLayer = null;
    regionLayerIndex.clear();
    removeLegend();
    return;
  }

  const breaksGwh = quantileBreaks(valuesGwh, 5);

  allRegions = features
    .map(f => f.properties.region)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a.localeCompare(b));

  if (geoLayer) map.removeLayer(geoLayer);
  regionLayerIndex.clear();

  geoLayer = L.geoJSON(features, {
    style: (feature) => {
      const gwh = Number(feature.properties.value_gwh);
      return {
        weight: 1,
        color: "#444",
        fillOpacity: 0.75,
        fillColor: getColorByBreaks(gwh, breaksGwh)
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      regionLayerIndex.set(p.region, layer);

      layer.bindPopup(
        `<b>${p.region}</b><br/>
         Season: ${p.period}<br/>
         Production: ${formatGWh(Number(p.value_gwh))} GWh`
      );

      layer.on("click", () => {
        selectedRegion = p.region;
        comboLabel.textContent = p.region;
      });
    }
  }).addTo(map);

  addLegend(breaksGwh);
  updateTop5Chart(features, season);

  if (selectedRegion && regionLayerIndex.has(selectedRegion)) {
    zoomToRegion(selectedRegion);
  } else {
    map.fitBounds(geoLayer.getBounds(), { padding: [10, 10] });
  }
}

// ===== UI events =====
seasonSelect.addEventListener("change", () => {
  renderSeason(seasonSelect.value).catch(console.error);
});

comboBtn.addEventListener("click", () => {
  if (comboPanel.classList.contains("open")) closeCombo();
  else openCombo();
});
comboSearch.addEventListener("input", () => {
  renderComboList(comboSearch.value);
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("regionCombo").contains(e.target)) closeCombo();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCombo();
});

// ===== Start =====
comboLabel.textContent = "All regions";
renderSeason(seasonSelect.value).catch(console.error);
