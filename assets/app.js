/* =========================
   Config
========================= */
const GEOJSON_URL = "data/rs_municipios_min.geojson";
const CSV_URL     = "data/pib_long.csv";

/* =========================
   State
========================= */
const state = {
  geo: null,
  codes: [],
  names: [],
  code2idx: new Map(),

  // records: {ano, code, muni, variavel, serie, valor}
  records: [],

  // cube: key = `${variavel}||${serie}` -> { years: [...], byYear: Map(year -> Array(nCodes).fill(null)) }
  cube: new Map(),

  // helpers
  varList: [],
  serieList: [],
  comboYears: new Map(), // key -> sorted years
};

/* =========================
   Utils
========================= */
function $(id){ return document.getElementById(id); }

function sanitizeFilename(s) {
  return String(s)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 110);
}

function formatBRL(x) {
  if (x === null || x === undefined || !isFinite(x)) return "";
  // separadores pt-BR (sem cents)
  return "R$ " + Number(x).toLocaleString("pt-BR", {maximumFractionDigits: 0});
}

// quantil p05-p95 (para contraste por ano)
function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function buildKey(v, s){ return `${v}||${s}`; }

/* =========================
   Loaders
========================= */
async function loadGeo() {
  const res = await fetch(GEOJSON_URL);
  if (!res.ok) throw new Error("Falha ao carregar GeoJSON.");
  const geo = await res.json();

  state.geo = geo;
  state.codes = geo.features.map(ft => String(ft.properties.CD_MUN7));
  state.names = geo.features.map(ft => String(ft.properties.NM_MUN || ft.properties.CD_MUN7));
  state.code2idx = new Map(state.codes.map((c,i)=>[c,i]));
}

async function loadCSV() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error("Falha ao carregar CSV.");
  const text = await res.text();

  const parsed = Papa.parse(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true
  });

  if (parsed.errors?.length) {
    console.warn("Erros CSV:", parsed.errors.slice(0,5));
  }

  const rows = parsed.data;

  // normaliza campos
  const recs = [];
  for (const r of rows) {
    const ano = Number(r["Ano"]);
    const code = String(r["CD_MUN7"] ?? "");
    const muni = String(r["Nome do Município"] ?? "");
    const variavel = String(r["variavel"] ?? "");
    const serie = String(r["serie"] ?? "");
    const valor = Number(r["valor_brl"]);

    if (!isFinite(ano) || !code || !variavel || !serie || !isFinite(valor)) continue;
    if (!state.code2idx.has(code)) continue;

    recs.push({ano, code, muni, variavel, serie, valor});
  }

  state.records = recs;

  // listas de variável/série
  state.varList = Array.from(new Set(recs.map(d => d.variavel))).sort();
  state.serieList = Array.from(new Set(recs.map(d => d.serie))).sort();

  // montar cube
  state.cube.clear();
  state.comboYears.clear();

  for (const d of recs) {
    const key = buildKey(d.variavel, d.serie);
    if (!state.cube.has(key)) state.cube.set(key, { byYear: new Map() });
    const box = state.cube.get(key);
    if (!box.byYear.has(d.ano)) box.byYear.set(d.ano, new Array(state.codes.length).fill(null));
    const arr = box.byYear.get(d.ano);
    arr[state.code2idx.get(d.code)] = d.valor;
  }

  // years por combo
  for (const [key, box] of state.cube.entries()) {
    const years = Array.from(box.byYear.keys()).sort((a,b)=>a-b);
    state.comboYears.set(key, years);
  }
}

/* =========================
   UI setup
========================= */
function fillSelect(selectEl, options, preferredTextIncludes=null) {
  selectEl.innerHTML = "";
  options.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    selectEl.appendChild(opt);
  });

  if (preferredTextIncludes) {
    const found = options.find(o => o.toLowerCase().includes(preferredTextIncludes.toLowerCase()));
    if (found) selectEl.value = found;
  } else if (options.length) {
    selectEl.value = options[0];
  }
}

function fillYears(selectEl, years) {
  selectEl.innerHTML = "";
  years.forEach((y) => {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    selectEl.appendChild(opt);
  });
  if (years.length) selectEl.value = String(years[years.length - 1]);
}

function fillMunicipios(selectEl, varName, serieName) {
  // popula municípios que têm dados nessa combinação
  const key = buildKey(varName, serieName);
  const set = new Map(); // muni -> code

  for (const d of state.records) {
    if (d.variavel !== varName || d.serie !== serieName) continue;
    if (!set.has(d.muni)) set.set(d.muni, d.code);
  }

  const munis = Array.from(set.keys()).sort((a,b)=>a.localeCompare(b,"pt-BR"));
  selectEl.innerHTML = "";
  for (const m of munis) {
    const opt = document.createElement("option");
    opt.value = set.get(m);  // value = code
    opt.textContent = m;
    selectEl.appendChild(opt);
  }
}

/* =========================
   PANORAMA: Map  (CORRIGIDO)
========================= */
function renderMap(varName, serieName) {
  const key = buildKey(varName, serieName);
  const years = state.comboYears.get(key) || [];
  if (!years.length) {
    Plotly.newPlot("divMap", [], { title: "Sem dados" });
    return;
  }

  const box = state.cube.get(key);
  const byYear = box.byYear;

  const y0 = years[0];
  const z0 = byYear.get(y0);

  const ann = (y) => ([{
    text: `Ano: <b>${y}</b>`,
    x: 0.99, y: 0.99,
    xref: "paper", yref: "paper",
    xanchor: "right", yanchor: "top",
    showarrow: false,
    bgcolor: "rgba(255,255,255,0.75)",
    bordercolor: "rgba(0,0,0,0.20)",
    borderwidth: 1,
    font: { size: 12 }
  }]);

  const frames = years.map((y) => {
    const z = byYear.get(y);

    // escala por ano (p05–p95) p/ contraste
    const vals = z.filter(v => v != null && isFinite(v)).slice().sort((a, b) => a - b);
    let cmin = quantile(vals, 0.05);
    let cmax = quantile(vals, 0.95);
    if (cmin == null || cmax == null) { cmin = 0; cmax = 1; }
    if (cmax <= cmin) cmax = cmin + 1;

    return {
      name: String(y),
      data: [{
        z,
        meta: y
      }],
      layout: {
        coloraxis: { cmin, cmax },
        annotations: ann(y)
      }
    };
  });

  const trace = {
    type: "choropleth",
    geojson: state.geo,
    featureidkey: "properties.CD_MUN7",
    locations: state.codes,
    z: z0,
    text: state.names,
    meta: y0,
    coloraxis: "coloraxis",
    hovertemplate:
      "<b>%{text}</b><br>" +
      "Ano: %{meta}<br>" +
      "Valor: R$ %{z:,.0f}<extra></extra>"
  };

  const layout = {
    title: {
      text: `RS — ${varName} (${serieName})`,
      x: 0.02, xanchor: "left",
      font: { size: 14 }
    },
    height: 520,
    // mais espaço no topo (título não invade o mapa)
    margin: { l: 10, r: 10, t: 88, b: 0 },
    separators: ".,",
    geo: { fitbounds: "locations", visible: false },
    coloraxis: {
      colorscale: "Viridis",
      colorbar: { title: "R$ (escala por ano: p05–p95)" }
    },
    annotations: ann(y0),
    updatemenus: [{
      type: "buttons",
      direction: "left",
      x: 0.02, y: 0.02,
      xanchor: "left", yanchor: "bottom",
      showactive: false,
      buttons: [
        {
          label: "Play",
          method: "animate",
          args: [null, { fromcurrent: true, frame: { duration: 700, redraw: true }, transition: { duration: 0 } }]
        },
        {
          label: "Pause",
          method: "animate",
          args: [[null], { mode: "immediate", frame: { duration: 0, redraw: false }, transition: { duration: 0 } }]
        }
      ]
    }],
    sliders: [{
      active: 0,
      x: 0.20, y: 0.02, len: 0.78,
      xanchor: "left", yanchor: "bottom",
      currentvalue: { prefix: "Ano: " },
      steps: years.map((y) => ({
        label: String(y),
        method: "animate",
        args: [[String(y)], { mode: "immediate", frame: { duration: 0, redraw: true }, transition: { duration: 0 } }]
      }))
    }]
  };

  Plotly.newPlot("divMap", [trace], layout, { displayModeBar: true }).then((gd) => {
    Plotly.addFrames(gd, frames);
  });
}

/* =========================
   PANORAMA: Bar chart race (CORRIGIDO)
========================= */
function renderRace(varName, serieName, topN) {
  const key = buildKey(varName, serieName);
  const years = state.comboYears.get(key) || [];
  if (!years.length) {
    Plotly.newPlot("divRace", [], { title: "Sem dados" });
    return;
  }

  const byYear = state.cube.get(key).byYear;

  function topForYear(y) {
    const z = byYear.get(y);
    const items = [];
    for (let i = 0; i < z.length; i++) {
      const v = z[i];
      if (v == null || !isFinite(v)) continue;
      items.push({ idx: i, code: state.codes[i], name: state.names[i], val: v });
    }
    items.sort((a, b) => b.val - a.val);
    return items.slice(0, topN);
  }

  // FIX: range X fixo (não re-escala ao longo do tempo -> não desloca)
  let globalMax = 0;
  for (const y of years) {
    const z = byYear.get(y);
    for (const v of z) {
      if (v != null && isFinite(v) && v > globalMax) globalMax = v;
    }
  }
  if (!globalMax || !isFinite(globalMax)) globalMax = 1;
  const xMax = globalMax * 1.05;

  const y0 = years[0];
  const top0 = topForYear(y0).reverse();

  const ann = (y) => ([{
    text: `Ano: <b>${y}</b>`,
    x: 0.99, y: 0.98,
    xref: "paper", yref: "paper",
    xanchor: "right", yanchor: "top",
    showarrow: false,
    bgcolor: "rgba(255,255,255,0.75)",
    bordercolor: "rgba(0,0,0,0.20)",
    borderwidth: 1,
    font: { size: 12 }
  }]);

  const frames = years.map((y) => {
    const top = topForYear(y).reverse();
    return {
      name: String(y),
      data: [{
        x: top.map(d => d.val),
        y: top.map(d => d.name),
        customdata: top.map(d => [d.code]),
        meta: y
      }],
      layout: {
        annotations: ann(y)
      }
    };
  });

  const trace = {
    type: "bar",
    orientation: "h",
    x: top0.map(d => d.val),
    y: top0.map(d => d.name),
    customdata: top0.map(d => [d.code]),
    meta: y0,
    hovertemplate:
      "<b>%{y}</b><br>" +
      "Ano: %{meta}<br>" +
      "Código: %{customdata[0]}<br>" +
      "Valor: R$ %{x:,.0f}<extra></extra>"
  };

  const layout = {
    title: {
      text: `Top ${topN} — ${varName} (${serieName})`,
      x: 0.02, xanchor: "left",
      font: { size: 14 }
    },
    height: 520,
    // FIX: margens fixas (evita reflow/deslocamento)
    margin: { l: 260, r: 10, t: 78, b: 40 },
    separators: ".,",
    xaxis: {
      title: "R$",
      tickformat: ",.0f",
      range: [0, xMax],
      fixedrange: true
    },
    yaxis: {
      automargin: false,
      fixedrange: true,
      tickfont: { size: 11 }
    },
    annotations: ann(y0),
    updatemenus: [{
      type: "buttons",
      direction: "left",
      x: 0.02, y: 0.02,
      xanchor: "left", yanchor: "bottom",
      showactive: false,
      buttons: [
        { label: "Play", method: "animate", args: [null, { fromcurrent: true, frame: { duration: 650, redraw: true }, transition: { duration: 0 } }] },
        { label: "Pause", method: "animate", args: [[null], { mode: "immediate", frame: { duration: 0, redraw: false }, transition: { duration: 0 } }] }
      ]
    }],
    sliders: [{
      active: 0,
      x: 0.20, y: 0.02, len: 0.78,
      xanchor: "left", yanchor: "bottom",
      currentvalue: { prefix: "Ano: " },
      steps: years.map(y => ({
        label: String(y),
        method: "animate",
        args: [[String(y)], { mode: "immediate", frame: { duration: 0, redraw: true }, transition: { duration: 0 } }]
      }))
    }]
  };

  Plotly.newPlot("divRace", [trace], layout, { displayModeBar: true }).then(gd => {
    Plotly.addFrames(gd, frames);
  });
}

/* =========================
   Ranking table
========================= */
function updateRankingTable(varName, serieName, year, topN) {
  const key = buildKey(varName, serieName);
  const box = state.cube.get(key);
  const arr = box?.byYear.get(Number(year));
  const tbody = $("tblRanking").querySelector("tbody");
  tbody.innerHTML = "";

  if (!arr) {
    $("rankingMeta").textContent = "Sem dados.";
    return;
  }

  const items = [];
  for (let i=0; i<arr.length; i++) {
    const v = arr[i];
    if (v == null || !isFinite(v)) continue;
    items.push({idx:i, code:state.codes[i], name:state.names[i], val:v});
  }
  items.sort((a,b)=>b.val-a.val);
  const top = items.slice(0, topN);

  $("rankingMeta").textContent = `Ano: ${year} | Top ${topN} | ${varName} (${serieName})`;

  top.forEach((d, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i+1}</td>
      <td>${d.name}</td>
      <td>${d.code}</td>
      <td class="text-end">${formatBRL(d.val)}</td>
    `;
    tbody.appendChild(tr);
  });

  return top; // útil p/ export Word
}

/* =========================
   SERIES (aba municípios)
========================= */
function getSelectedCodes(selectEl) {
  return Array.from(selectEl.selectedOptions).map(o => o.value);
}

function renderSeriesChart(varName, serieName, codesSelected, showMeanYear) {
  const key = buildKey(varName, serieName);
  const years = state.comboYears.get(key) || [];
  const byYear = state.cube.get(key)?.byYear;

  if (!years.length || !byYear || !codesSelected.length) {
    Plotly.newPlot("divSeries", [], {title: "Selecione municípios e filtros."});
    return;
  }

  // matrix: years x munis
  const traces = [];
  const muniIdxs = codesSelected.map(c => state.code2idx.get(String(c))).filter(i => i !== undefined);

  // linhas por município
  for (const idx of muniIdxs) {
    const name = state.names[idx];
    const yvals = years.map(y => {
      const arr = byYear.get(y);
      const v = arr ? arr[idx] : null;
      return (v==null || !isFinite(v)) ? null : v;
    });

    traces.push({
      type: "scatter",
      mode: "lines",
      name,
      x: years,
      y: yvals,
      hovertemplate: "<b>%{fullData.name}</b><br>Ano: %{x}<br>Valor: R$ %{y:,.0f}<extra></extra>"
    });
  }

  // média anual (selecionados)
  const meanYear = years.map((y) => {
    const arr = byYear.get(y);
    if (!arr) return null;
    let sum=0, n=0;
    for (const idx of muniIdxs) {
      const v = arr[idx];
      if (v==null || !isFinite(v)) continue;
      sum += v; n++;
    }
    return n ? sum/n : null;
  });

  // média do período (reta): média de todos os pontos (anos x municípios)
  let sumAll=0, nAll=0;
  for (let t=0; t<years.length; t++) {
    const arr = byYear.get(years[t]);
    if (!arr) continue;
    for (const idx of muniIdxs) {
      const x = arr[idx];
      if (x==null || !isFinite(x)) continue;
      sumAll += x; nAll++;
    }
  }
  const meanPeriod = nAll ? (sumAll/nAll) : null;

  if (showMeanYear) {
    traces.push({
      type:"scatter", mode:"lines",
      name:"Média anual (selecionados)",
      x: years, y: meanYear,
      line:{width:4},
      hovertemplate:"Ano: %{x}<br>Média anual: R$ %{y:,.0f}<extra></extra>"
    });
  }

  if (meanPeriod != null) {
    traces.push({
      type:"scatter", mode:"lines",
      name:"Média do período (reta)",
      x: years, y: years.map(()=>meanPeriod),
      line:{dash:"dot", width:3},
      hovertemplate:"Ano: %{x}<br>Média do período: R$ %{y:,.0f}<extra></extra>"
    });
  }

  // tendência (OLS) da média anual
  const xs = [];
  const ys = [];
  for (let i=0; i<years.length; i++) {
    const v = meanYear[i];
    if (v==null || !isFinite(v)) continue;
    xs.push(years[i]);
    ys.push(v);
  }
  if (xs.length >= 2) {
    const n = xs.length;
    const xbar = xs.reduce((a,b)=>a+b,0)/n;
    const ybar = ys.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0;
    for (let i=0; i<n; i++) {
      num += (xs[i]-xbar)*(ys[i]-ybar);
      den += (xs[i]-xbar)*(xs[i]-xbar);
    }
    const a = den ? (num/den) : 0;
    const b = ybar - a*xbar;
    const yhat = years.map(y => a*y + b);

    traces.push({
      type:"scatter", mode:"lines",
      name:"Tendência (OLS) da média anual",
      x: years, y: yhat,
      line:{dash:"dash", width:3},
      hovertemplate:"Ano: %{x}<br>Tendência: R$ %{y:,.0f}<extra></extra>"
    });
  }

  const muniNames = muniIdxs.map(i=>state.names[i]);
  $("seriesMeta").textContent = `${varName} (${serieName}) | Municípios: ${muniNames.slice(0,6).join(", ")}${muniNames.length>6?"…":""}`;

  const layout = {
    title: `Série temporal — ${varName} (${serieName})`,
    height: 620,
    margin: {l: 10, r: 10, t: 50, b: 35},
    separators: ".,",
    hovermode: "x unified",
    xaxis: {title:"Ano"},
    yaxis: {title:"R$"}
  };

  Plotly.newPlot("divSeries", traces, layout, {displayModeBar:true});
}

function updateSeriesTable(varName, serieName, codesSelected) {
  const key = buildKey(varName, serieName);
  const years = state.comboYears.get(key) || [];
  const byYear = state.cube.get(key)?.byYear;
  const tbody = $("tblSeries").querySelector("tbody");
  tbody.innerHTML = "";

  if (!years.length || !byYear || !codesSelected.length) return [];

  const muniIdxs = codesSelected.map(c => state.code2idx.get(String(c))).filter(i => i !== undefined);

  const rowsOut = [];
  for (const y of years) {
    const arr = byYear.get(y);
    if (!arr) continue;
    for (const idx of muniIdxs) {
      const v = arr[idx];
      if (v==null || !isFinite(v)) continue;
      rowsOut.push({ano:y, muni:state.names[idx], code:state.codes[idx], val:v});
    }
  }

  // ordenar por ano, muni
  rowsOut.sort((a,b)=> (a.ano-b.ano) || a.muni.localeCompare(b.muni,"pt-BR"));

  for (const r of rowsOut) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.ano}</td>
      <td>${r.muni}</td>
      <td>${r.code}</td>
      <td class="text-end">${formatBRL(r.val)}</td>
    `;
    tbody.appendChild(tr);
  }

  return rowsOut;
}

/* =========================
   "Salvar no Word" (arquivo .doc)
   Word abre HTML perfeitamente.
========================= */
function downloadWordDoc(filenameBase, title, filters, tableHeaders, tableRows) {
  const safeName = sanitizeFilename(filenameBase);
  const fname = `${safeName}.doc`;

  const style = `
    <style>
      body { font-family: Calibri, Arial, sans-serif; }
      h1 { font-size: 16pt; margin-bottom: 6px; }
      .meta { color:#333; font-size: 10.5pt; margin-bottom: 10px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #999; padding: 6px; font-size: 10.5pt; }
      th { background: #f2f2f2; }
      td.num { text-align: right; }
    </style>
  `;

  const metaHtml = `
    <div class="meta">
      ${filters.map(x => `<div>${x}</div>`).join("")}
      <div>Gerado em: ${new Date().toLocaleString("pt-BR")}</div>
    </div>
  `;

  const thead = `<tr>${tableHeaders.map(h=>`<th>${h}</th>`).join("")}</tr>`;
  const tbody = tableRows.map(row =>
    `<tr>${row.map((cell) => {
      const isNum = (typeof cell === "number");
      const txt = isNum ? formatBRL(cell) : String(cell);
      return `<td class="${isNum ? "num" : ""}">${txt}</td>`;
    }).join("")}</tr>`
  ).join("");

  const html = `
    <html>
      <head>
        <meta charset="utf-8"/>
        ${style}
      </head>
      <body>
        <h1>${title}</h1>
        ${metaHtml}
        <table>
          <thead>${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
      </body>
    </html>
  `;

  const blob = new Blob([html], {type: "application/msword;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
}

/* =========================
   Orchestrators
========================= */
function syncPanoramaControls() {
  const v = $("selVar").value;
  const s = $("selSerie").value;
  const key = buildKey(v,s);
  const years = state.comboYears.get(key) || [];
  fillYears($("selAnoRanking"), years);
}

function applyPanorama() {
  const v = $("selVar").value;
  const s = $("selSerie").value;
  const topN = Math.max(5, Math.min(50, Number($("inpTopN").value || 15)));
  $("inpTopN").value = String(topN);

  const key = buildKey(v,s);
  const years = state.comboYears.get(key) || [];
  fillYears($("selAnoRanking"), years);

  $("statusPanorama").textContent = `OK — ${v} (${s}) | Anos: ${years[0]}–${years[years.length-1]}`;

  renderMap(v,s);
  renderRace(v,s,topN);

  const year = $("selAnoRanking").value || (years.length ? years[years.length-1] : "");
  updateRankingTable(v,s,year,topN);
}

function applySeries() {
  const v = $("selVar2").value;
  const s = $("selSerie2").value;
  const codesSelected = getSelectedCodes($("selMunis"));
  const showMeanYear = $("chkMeanYear").checked;

  const years = state.comboYears.get(buildKey(v,s)) || [];
  $("statusSeries").textContent = `OK — ${v} (${s}) | Anos disponíveis: ${years[0]}–${years[years.length-1]} | Selecionados: ${codesSelected.length}`;

  renderSeriesChart(v,s,codesSelected,showMeanYear);
  updateSeriesTable(v,s,codesSelected);
}

/* =========================
   Search filter for munis
========================= */
function filterMuniOptions(query) {
  query = String(query||"").trim().toLowerCase();
  const sel = $("selMunis");
  const options = Array.from(sel.options);
  for (const opt of options) {
    opt.hidden = query ? !opt.textContent.toLowerCase().includes(query) : false;
  }
}

/* =========================
   Init
========================= */
async function init() {
  $("statusPanorama").textContent = "Carregando…";
  $("statusSeries").textContent = "Carregando…";

  await loadGeo();
  await loadCSV();

  // Preencher selects panorama
  fillSelect($("selVar"), state.varList, "produto interno bruto");
  fillSelect($("selSerie"), state.serieList, "real");

  // Preencher selects municípios (aba 2)
  fillSelect($("selVar2"), state.varList, "produto interno bruto");
  fillSelect($("selSerie2"), state.serieList, "real");

  // preencher lista de municípios para combo inicial
  fillMunicipios($("selMunis"), $("selVar2").value, $("selSerie2").value);

  // listeners panorama
  $("selVar").addEventListener("change", () => { syncPanoramaControls(); applyPanorama(); });
  $("selSerie").addEventListener("change", () => { syncPanoramaControls(); applyPanorama(); });
  $("inpTopN").addEventListener("change", applyPanorama);
  $("selAnoRanking").addEventListener("change", () => {
    const v = $("selVar").value, s = $("selSerie").value;
    const topN = Number($("inpTopN").value || 15);
    updateRankingTable(v,s,$("selAnoRanking").value,topN);
  });
  $("btnUpdatePanorama").addEventListener("click", applyPanorama);

  // export ranking
  $("btnWordRanking").addEventListener("click", () => {
    const v = $("selVar").value;
    const s = $("selSerie").value;
    const year = $("selAnoRanking").value;
    const topN = Number($("inpTopN").value || 15);

    const top = updateRankingTable(v,s,year,topN) || [];
    const headers = ["#", "Município", "Código", "Valor"];
    const rows = top.map((d, i) => [i+1, d.name, d.code, d.val]);

    downloadWordDoc(
      `ranking_RS_${v}_${s}_${year}_top${topN}`,
      `Ranking — RS (${year})`,
      [
        `Variável: ${v}`,
        `Série: ${s}`,
        `Ano: ${year}`,
        `Top N: ${topN}`
      ],
      headers,
      rows
    );
  });

  // listeners série (aba 2)
  $("selVar2").addEventListener("change", () => {
    fillMunicipios($("selMunis"), $("selVar2").value, $("selSerie2").value);
    applySeries();
  });
  $("selSerie2").addEventListener("change", () => {
    fillMunicipios($("selMunis"), $("selVar2").value, $("selSerie2").value);
    applySeries();
  });
  $("selMunis").addEventListener("change", applySeries);
  $("chkMeanYear").addEventListener("change", applySeries);
  $("btnUpdateSeries").addEventListener("click", applySeries);

  $("inpSearchMuni").addEventListener("input", (e) => filterMuniOptions(e.target.value));

  // export série (lista)
  $("btnWordSeries").addEventListener("click", () => {
    const v = $("selVar2").value;
    const s = $("selSerie2").value;
    const codesSelected = getSelectedCodes($("selMunis"));
    if (!codesSelected.length) return;

    const rows = updateSeriesTable(v,s,codesSelected); // [{ano,muni,code,val}]
    const headers = ["Ano", "Município", "Código", "Valor"];
    const tableRows = rows.map(r => [r.ano, r.muni, r.code, r.val]);

    const muniNames = codesSelected.map(c => state.names[state.code2idx.get(String(c))]).slice(0,6).join(", ");
    downloadWordDoc(
      `serie_RS_${v}_${s}_munis_${muniNames}`,
      `Série — Municípios selecionados`,
      [
        `Variável: ${v}`,
        `Série: ${s}`,
        `Municípios: ${muniNames}${codesSelected.length>6?"…":""}`
      ],
      headers,
      tableRows
    );
  });

  // recarregar
  $("btnReload").addEventListener("click", async () => {
    try{
      $("statusPanorama").textContent = "Recarregando…";
      $("statusSeries").textContent = "Recarregando…";
      await loadGeo();
      await loadCSV();
      applyPanorama();
      applySeries();
    } catch(e) {
      console.error(e);
      $("statusPanorama").textContent = "Erro ao recarregar.";
      $("statusSeries").textContent = "Erro ao recarregar.";
    }
  });

  // first render
  syncPanoramaControls();
  applyPanorama();
  applySeries();
}

init().catch((e)=>{
  console.error(e);
  $("statusPanorama").textContent = "Erro ao carregar dados.";
  $("statusSeries").textContent = "Erro ao carregar dados.";
});
