/* Tela do grafo — force-graph (2D) e 3d-force-graph (3D) da base RAG: filtros, legenda, destaques e modo conectar. */
import { api } from "../api.js";
import { t } from "../i18n.js";
import { graphTheme } from "../theme.js";
import { icon, loadIcons } from "../icons.js";
import { escHtml, debounce } from "../ui.js";
import { state, colorFor, store } from "../state.js";
import { on } from "../events.js";
import { closePanel, openConnectModal, openDocumentPanel } from "./docpanel.js";

/* ---------------------------------------------------------------- preferências do grafo (por navegador) */

const MODE_KEY = "concilium:graph-mode";
const LINK_SCALE_KEY = "concilium:graph-link-scale";
const LINK_SCALE_MIN = 0.3;
const LINK_SCALE_MAX = 3;

function loadGraphPrefs() {
  const mode = store.get(MODE_KEY);
  if (mode === "2d" || mode === "3d") state.graphMode = mode;
  const scale = Number(store.get(LINK_SCALE_KEY));
  if (scale >= LINK_SCALE_MIN && scale <= LINK_SCALE_MAX) state.linkScale = scale;
}

const fmtScale = (v) => `${v.toFixed(1)}×`;

/* ---------------------------------------------------------------- tela: grafo */


function graphTemplate() {
  loadGraphPrefs();
  return `
    <div class="split">
      <section class="page">
        <header class="page-header">
          <h1>${icon("network", 18)} ${t("graph.title")}</h1>
          <span class="sub" id="graph-sub"></span>
        </header>
        <div class="toolbar">
          <div class="field">${icon("folder")}<label for="f-collection">${t("graph.collection")}</label><select id="f-collection"><option value="">${t("graph.all")}</option></select></div>
          <div class="field">${icon("sliders-horizontal")}<label for="f-sim">${t("graph.similarity")} <span id="f-sim-val" class="mono">${state.minSimilarity.toFixed(2)}</span></label>
            <input type="range" id="f-sim" min="0" max="0.95" step="0.05" value="${state.minSimilarity}" />
          </div>
          <div class="field">${icon("spline")}<label for="f-width">${t("graph.lineWidth")} <span id="f-width-val" class="mono">${fmtScale(state.linkScale)}</span></label>
            <input type="range" id="f-width" min="${LINK_SCALE_MIN}" max="${LINK_SCALE_MAX}" step="0.1" value="${state.linkScale}" />
          </div>
          <div class="field tech"><label for="f-k">Top-k</label>
            <select id="f-k">${[1, 2, 3, 5, 8, 12, 20].map((k) => `<option ${k === state.k ? "selected" : ""}>${k}</option>`).join("")}</select>
          </div>
          <div class="seg tech" id="f-level">
            <button data-level="documents" class="${state.level === "documents" ? "active" : ""}">${t("graph.documents")}</button>
            <button data-level="chunks" class="${state.level === "chunks" ? "active" : ""}">${t("graph.chunks")}</button>
          </div>
          <div class="seg" id="f-mode" role="radiogroup" aria-label="${t("graph.view")}">
            <button data-mode="2d" role="radio" aria-checked="${state.graphMode === "2d"}" class="${state.graphMode === "2d" ? "active" : ""}">2D</button>
            <button data-mode="3d" role="radio" aria-checked="${state.graphMode === "3d"}" class="${state.graphMode === "3d" ? "active" : ""}" title="${t("graph.mode3dTitle")}">${icon("box", 14)}<span>3D</span></button>
          </div>
          <button class="btn sm hidden" id="hl-clear">${icon("check")}<span>${t("graph.clearHighlight")}</span></button>
          ${
            state.user?.role === "admin"
              ? `<button class="btn sm ghost" id="connect-mode" title="${t("graph.connectTitle")}">${icon("link", 14)}<span>${t("graph.connect")}</span></button>`
              : ""
          }
        </div>
        <div class="graph-wrap" id="graph-wrap">
          <!-- o force-graph limpa o elemento em que é montado: overlays ficam fora de #graph-canvas -->
          <div class="graph-canvas" id="graph-canvas"></div>
          <div class="empty-state" id="graph-empty">${t("graph.loading")}</div>
          <div class="legend hidden" id="graph-legend"></div>
          <div class="graph-notice hidden" id="graph-notice" role="status"></div>
          <div class="graph-hint hidden" id="graph-hint">${state.graphMode === "3d" ? t("graph.hint3d") : t("graph.hint")}</div>
          <div class="graph-zoom hidden" id="graph-zoom">
            <button class="icon-btn" id="zoom-fit" title="${t("graph.sync")}">${icon("refresh-cw")}</button>
          </div>
        </div>
      </section>
      <aside class="panel hidden" id="panel"></aside>
    </div>`;
}


function bindGraphControls() {
  const main = document.getElementById("main");
  const reloadSoon = debounce(loadGraph, 250);
  main.querySelector("#f-collection").addEventListener("change", (e) => {
    state.collection = e.target.value;
    loadGraph();
  });
  main.querySelector("#f-sim").addEventListener("input", (e) => {
    state.minSimilarity = Number(e.target.value);
    main.querySelector("#f-sim-val").textContent = state.minSimilarity.toFixed(2);
    reloadSoon();
  });
  // espessura: só restiliza (não recarrega do servidor); no 3D refaz as geometrias, então com debounce curto
  const restyleSoon = debounce(refreshGraphStyles, state.graphMode === "3d" ? 120 : 0);
  main.querySelector("#f-width").addEventListener("input", (e) => {
    state.linkScale = Number(e.target.value);
    main.querySelector("#f-width-val").textContent = fmtScale(state.linkScale);
    store.set(LINK_SCALE_KEY, state.linkScale);
    restyleSoon();
  });
  main.querySelector("#f-k").addEventListener("change", (e) => {
    state.k = Number(e.target.value);
    loadGraph();
  });
  main.querySelector("#f-level").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-level]");
    if (!btn) return;
    state.level = btn.dataset.level;
    main.querySelectorAll("#f-level button").forEach((b) => b.classList.toggle("active", b === btn));
    loadGraph();
  });
  main.querySelector("#f-mode").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn || btn.dataset.mode === state.graphMode) return;
    state.graphMode = btn.dataset.mode;
    store.set(MODE_KEY, state.graphMode);
    main.querySelectorAll("#f-mode button").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-checked", String(b === btn));
    });
    main.querySelector("#graph-hint").textContent = state.graphMode === "3d" ? t("graph.hint3d") : t("graph.hint");
    // 2D e 3D são instâncias diferentes: troca o renderizador e redesenha
    destroyGraph();
    document.getElementById("graph-canvas").innerHTML = "";
    loadGraph();
  });
  main.querySelector("#connect-mode")?.addEventListener("click", () => setConnectMode(!state.connectMode));
  main.querySelector("#hl-clear").addEventListener("click", () => {
    state.highlightDocs = null;
    loadGraph();
  });
  // sincronizar: recarrega o grafo do servidor e reenquadra (o ícone gira até terminar)
  main.querySelector("#zoom-fit").addEventListener("click", () => loadGraph());

  // legenda: hover destaca a coleção no grafo, clique filtra (ou volta para todas)
  const legend = main.querySelector("#graph-legend");
  const setLegendHover = (name) => {
    if (state.legendHover === name) return;
    state.legendHover = name;
    refreshGraphStyles();
  };
  legend.addEventListener("mouseover", (e) => setLegendHover(e.target.closest(".legend-row")?.dataset.col || null));
  legend.addEventListener("mouseleave", () => setLegendHover(null));
  legend.addEventListener("click", (e) => {
    if (e.target.closest("[data-toggle-semantic]")) {
      state.showSemantic = !state.showSemantic;
      loadGraph();
      return;
    }
    const btn = e.target.closest("[data-col]");
    if (!btn) return;
    setLegendHover(null);
    state.collection = btn.dataset.col;
    main.querySelector("#f-collection").value = state.collection;
    loadGraph();
  });
}

let graphRequest = 0;

// Grafo com nós mas sem arestas: descobre a conexão mais forte (consulta com threshold 0, k=1)
// e oferece baixar o slider até ela — senão parece que o grafo "quebrou".
async function explainMissingEdges(data, req) {
  const notice = document.getElementById("graph-notice");
  notice.classList.add("hidden");
  if (!state.showSemantic || data.edges.some((e) => e.kind === "semantic") || data.nodes.length < 2) return;
  let probe;
  try {
    probe = await api.get("/graph", { level: state.level, collection: state.collection, min_similarity: 0, k: 1 });
  } catch {
    return;
  }
  if (req !== graphRequest) return; // o usuário já mudou o filtro
  const strongest = Math.max(0, ...probe.edges.filter((e) => e.kind === "semantic").map((e) => e.similarity));
  if (!strongest) return;
  // passo do slider é 0.05: arredonda para baixo para a aresta mais forte aparecer
  const target = Math.floor(strongest * 20) / 20;
  const fmt = (v) => v.toFixed(2);
  notice.innerHTML = `
    <span>${t("graph.noEdges", { min: fmt(state.minSimilarity), max: fmt(strongest) })}</span>
    <button class="btn sm" type="button" id="notice-lower">${t("graph.showFrom", { value: fmt(target) })}</button>`;
  notice.classList.remove("hidden");
  notice.querySelector("#notice-lower").addEventListener("click", () => {
    state.minSimilarity = target;
    document.getElementById("f-sim").value = target;
    document.getElementById("f-sim-val").textContent = fmt(target);
    loadGraph();
  });
}

// Animação do botão de sincronizar: gira enquanto carrega/assenta/enquadra o grafo.
// Ao parar, completa a volta em andamento para o ícone não "pular".
const SYNC_TURN_MS = 700;
let syncSince = 0;
let syncTimer = null;
let syncSafety = null;

function setGraphSyncing(on) {
  const btn = document.getElementById("zoom-fit");
  if (!btn) return;
  clearTimeout(syncTimer);
  clearTimeout(syncSafety);
  if (on) {
    if (!btn.classList.contains("syncing")) syncSince = performance.now();
    btn.classList.add("syncing");
    btn.setAttribute("aria-busy", "true");
    // segurança: nunca girar para sempre se a simulação não sinalizar o fim
    syncSafety = setTimeout(() => setGraphSyncing(false), 10000);
    return;
  }
  const rest = SYNC_TURN_MS - ((performance.now() - syncSince) % SYNC_TURN_MS);
  syncTimer = setTimeout(() => {
    btn.classList.remove("syncing");
    btn.removeAttribute("aria-busy");
  }, rest);
}

async function loadGraph() {
  const req = ++graphRequest;
  setGraphSyncing(true);
  let data;
  try {
    const [resp] = await Promise.all([
      api.get("/graph", {
        level: state.level,
        collection: state.collection,
        min_similarity: state.minSimilarity,
        k: state.k,
      }),
      state.graphMode === "3d" ? load3dLibrary() : null,
    ]);
    data = resp;
  } catch {
    if (req === graphRequest) graphMessage(state.graphMode === "3d" && !window.ForceGraph3D ? t("graph.mode3dFailed") : t("graph.loadFailed"));
    return;
  }
  // resposta atrasada de um filtro anterior: descarta
  if (req !== graphRequest || !document.getElementById("graph-wrap")) return;
  fillCollectionFilter(data.collections);
  if (!data.nodes.length) {
    graphMessage(t("graph.empty"));
    return;
  }
  drawGraph(data);
  explainMissingEdges(data, req);
}

// O 3D (three.js embutido, ~1,4 MB) só é baixado quando a pessoa escolhe 3D. O caminho é derivado
// do <script> do force-graph para herdar o prefixo versionado dos estáticos (cache imutável).
let load3dPromise = null;
function load3dLibrary() {
  if (window.ForceGraph3D) return Promise.resolve();
  if (!load3dPromise) {
    load3dPromise = new Promise((resolve, reject) => {
      const base = document.querySelector('script[src*="force-graph.min.js"]')?.getAttribute("src") || "static/vendor/force-graph.min.js";
      const s = document.createElement("script");
      s.src = base.replace(/force-graph\.min\.js$/, "3d-force-graph/3d-force-graph.min.js");
      s.onload = () => resolve();
      s.onerror = () => {
        load3dPromise = null; // permite tentar de novo
        s.remove();
        reject(new Error("3d-force-graph"));
      };
      document.head.appendChild(s);
    });
  }
  return load3dPromise;
}

function destroyGraph() {
  if (state.connectMode) setConnectMode(false);
  if (state.graphObserver) state.graphObserver.disconnect();
  if (state.graphInstance) {
    state.graphInstance.pauseAnimation();
    state.graphInstance._destructor && state.graphInstance._destructor();
  }
  state.graphObserver = null;
  state.graphInstance = null;
  state.graphInstanceMode = null;
  state.hoverNode = null;
}

function graphMessage(msg) {
  setGraphSyncing(false);
  destroyGraph();
  const canvas = document.getElementById("graph-canvas");
  if (canvas) canvas.innerHTML = "";
  for (const id of ["graph-legend", "graph-hint", "graph-zoom", "graph-notice"]) {
    document.getElementById(id)?.classList.add("hidden");
  }
  const empty = document.getElementById("graph-empty");
  if (empty) {
    empty.textContent = msg;
    empty.classList.remove("hidden");
  }
  const sub = document.getElementById("graph-sub");
  if (sub) sub.textContent = "";
}

function fillCollectionFilter(collections) {
  const sel = document.getElementById("f-collection");
  const current = state.collection;
  sel.innerHTML =
    `<option value="">${t("graph.all")}</option>` +
    collections.map((c) => `<option value="${escHtml(c.name)}" ${c.name === current ? "selected" : ""}>${escHtml(c.name)} (${c.count})</option>`).join("");
}

function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const MAX_FIT_ZOOM = 2.2;

function fitGraph() {
  const g = state.graphInstance;
  if (!g) return;
  if (state.graphInstanceMode === "3d") {
    g.zoomToFit(600, 10);
    setTimeout(() => setGraphSyncing(false), 600);
    return;
  }
  // calcula o enquadramento instantâneo, volta à vista atual e anima até o alvo
  // com o zoom limitado (com poucos nós o zoomToFit aproxima demais)
  const fromZoom = g.zoom();
  const fromCenter = g.centerAt();
  g.zoomToFit(0, 80);
  const toZoom = Math.min(g.zoom(), MAX_FIT_ZOOM);
  const toCenter = g.centerAt();
  g.zoom(fromZoom, 0).centerAt(fromCenter.x, fromCenter.y, 0);
  g.centerAt(toCenter.x, toCenter.y, 400).zoom(toZoom, 400);
  setTimeout(() => setGraphSyncing(false), 400);
}

/* ---------------------------------------------------------------- estilo (compartilhado pelo 2D e pelo 3D) */

// Calculado a cada drawGraph: vizinhança (para o foco do hover), grau (tamanho e prioridade do rótulo)
// e as funções de cor/espessura que os dois renderizadores usam.
let view = null;

function buildView(data) {
  const colors = graphTheme();
  const highlight = state.highlightDocs && state.highlightDocs.size ? state.highlightDocs : null;
  const nodeKey = (n) => (state.level === "documents" ? n.id : n.document_id);
  const isHl = (n) => Boolean(highlight && highlight.has(nodeKey(n)));
  const visibleEdges = state.showSemantic ? data.edges : data.edges.filter((e) => e.kind === "link");

  const degree = new Map();
  const neighbors = new Map();
  for (const e of visibleEdges) {
    for (const [a, b] of [
      [e.source, e.target],
      [e.target, e.source],
    ]) {
      degree.set(a, (degree.get(a) || 0) + 1);
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      neighbors.get(a).add(b);
    }
  }
  const idOf = (x) => (x && typeof x === "object" ? x.id : x);

  // força da similaridade relativa ao threshold atual: 0 (no limite) .. 1 (idêntico)
  const strength = (l) => (l.similarity == null ? 1 : Math.max(0, Math.min(1, (l.similarity - state.minSimilarity) / (1 - state.minSimilarity || 1))));

  // foco: nó em hover (ou origem do modo conectar) + vizinhos diretos
  const focusId = () => idOf(state.hoverNode || state.connectFrom || null);
  const inFocus = (n) => {
    const f = focusId();
    return f != null && (n.id === f || neighbors.get(f)?.has(n.id));
  };
  const linkTouchesFocus = (l) => {
    const f = focusId();
    return f != null && (idOf(l.source) === f || idOf(l.target) === f);
  };

  const radius = (n) => {
    const deg = degree.get(n.id) || 0;
    const base = state.level === "documents" ? Math.min(14, 3.5 + 1.7 * Math.sqrt(deg) + 0.6 * Math.sqrt(n.chunks || 1)) : 3.5 + Math.sqrt(deg);
    return isHl(n) ? base * 1.4 : base;
  };

  const nodeDimmed = (n) => {
    if (state.legendHover && n.collection !== state.legendHover) return true;
    if (highlight && !isHl(n)) return true;
    return focusId() != null && !inFocus(n);
  };

  const nodeColor = (n) => {
    if (highlight && isHl(n)) return colors.accent;
    return nodeDimmed(n) ? hexAlpha(n.color, 0.2) : n.color;
  };

  const linkColor = (l) => {
    const f = focusId() != null;
    if (f && !linkTouchesFocus(l)) return `rgba(${colors.edgeRgb}, 0.04)`;
    if (highlight && !(isHl(l.source) && isHl(l.target))) return `rgba(${colors.edgeRgb}, 0.04)`;
    if (state.legendHover && !(l.source?.collection === state.legendHover && l.target?.collection === state.legendHover)) {
      return `rgba(${colors.edgeRgb}, 0.05)`;
    }
    if (l.kind === "link") return `rgba(${colors.accentRgb}, ${f ? 1 : 0.85})`;
    if (f || highlight) return `rgba(${colors.accentRgb}, 0.6)`;
    // similaridade: discreta, mais visível quanto mais forte
    return `rgba(${colors.edgeRgb}, ${(0.1 + strength(l) * 0.4).toFixed(3)})`;
  };

  const linkWidth = (l) => {
    const base = l.kind === "link" ? 1.8 : 0.6 + strength(l) * 1.6;
    return base * state.linkScale * (linkTouchesFocus(l) ? 1.5 : 1);
  };

  return { colors, highlight, isHl, nodeKey, visibleEdges, degree, neighbors, radius, nodeDimmed, nodeColor, linkColor, linkWidth, inFocus, focusId };
}

// Reaplica cores/espessuras sem recarregar do servidor (hover, legenda, slider de espessura).
function refreshGraphStyles() {
  const g = state.graphInstance;
  if (!g || !view) return;
  if (state.graphInstanceMode === "3d") {
    g.nodeColor(view.nodeColor).linkColor(view.linkColor).linkWidth(view.linkWidth);
    return;
  }
  // 2D: reatribuir o acessor força o redesenho mesmo com a simulação pausada
  g.linkWidth(view.linkWidth).linkColor(view.linkColor);
}

/* ---------------------------------------------------------------- renderizador 2D (canvas) */

function create2dGraph(el) {
  const g = ForceGraph()(el)
    .backgroundColor("rgba(0,0,0,0)")
    .nodeId("id")
    .nodeRelSize(5)
    .nodeLabel(() => "")
    .linkDirectionalParticles(0)
    .cooldownTicks(120)
    .onNodeHover((n) => {
      state.hoverNode = n || null;
      el.style.cursor = n ? "pointer" : "";
      refreshGraphStyles();
    })
    .onNodeClick((n) => onGraphNodeClick(n))
    .onBackgroundClick(() => closePanel())
    .onEngineStop(() => {
      if (state.graphNeedsFit) {
        state.graphNeedsFit = false;
        fitGraph();
      }
    });
  g.d3Force("charge").strength(-180);
  const resize = () => g.width(el.clientWidth).height(el.clientHeight);
  resize();
  state.graphObserver = new ResizeObserver(resize);
  state.graphObserver.observe(el);
  return g;
}

const LABEL_FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

// Rótulos num passe próprio, depois de nós e arestas: ficam por cima de tudo e entram em ordem de
// importância (foco > destaque > mais conexões). Rótulo que colidiria com um já desenhado é pulado —
// sem isso, com dezenas de nós, os títulos viravam uma mancha ilegível no centro.
function drawLabels2d(ctx, scale, nodes) {
  const v = view;
  if (!v) return;
  const focused = v.focusId() != null;
  const prio = (n) => (state.hoverNode === n || state.connectFrom === n ? 3 : v.inFocus(n) ? 2 : v.isHl(n) ? 1.5 : 0) * 1000 + (v.degree.get(n.id) || 0);
  const ordered = [...nodes].sort((a, b) => prio(b) - prio(a));
  const boxes = [];
  const fontSize = 12 / scale;
  const pad = 3 / scale;
  for (const n of ordered) {
    const isFocus = v.inFocus(n);
    const hovered = state.hoverNode === n || state.connectFrom === n;
    // com foco ativo, só a vizinhança ganha rótulo; sem foco, longe demais só os nós grandes
    if (focused && !isFocus) continue;
    if (!focused && scale < 0.55 && (v.degree.get(n.id) || 0) < 6) continue;
    const max = hovered ? 64 : 30;
    const text = n.label.length > max ? n.label.slice(0, max - 1) + "…" : n.label;
    ctx.font = `${hovered ? 600 : 500} ${fontSize}px ${LABEL_FONT}`;
    const w = ctx.measureText(text).width;
    const r = v.radius(n);
    const box = { x: n.x - w / 2 - pad, y: n.y + r + 4 / scale - pad, w: w + 2 * pad, h: fontSize + 2 * pad };
    const hits = boxes.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y);
    if (hits && !hovered) continue;
    boxes.push(box);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // contorno na cor do fundo: o texto continua legível por cima das arestas
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = v.colors.bg;
    ctx.strokeText(text, n.x, n.y + r + 4 / scale);
    ctx.fillStyle = hovered ? v.colors.labelHover : v.nodeDimmed(n) && !isFocus ? v.colors.labelDim : v.colors.label;
    ctx.fillText(text, n.x, n.y + r + 4 / scale);
  }
}

function draw2d(g, nodes, links) {
  const v = view;
  g.nodeVal((n) => (v.radius(n) / 5) ** 2)
    .nodeCanvasObjectMode(() => "replace")
    .nodeCanvasObject((n, ctx, scale) => {
      const r = v.radius(n);
      const hovered = state.hoverNode === n || state.connectFrom === n;
      const dim = v.nodeDimmed(n);
      // halo: discreto em todos, forte no foco
      if (!dim) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + (hovered ? 7 : 3.5), 0, 2 * Math.PI);
        ctx.fillStyle = hexAlpha(v.highlight && v.isHl(n) ? v.colors.accent : n.color, hovered ? 0.3 : 0.12);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = v.nodeColor(n);
      ctx.fill();
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = v.colors.nodeStroke;
      // contorno esmaece junto com o nó (no tema claro o anel escuro pesava sobre o nó apagado)
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    })
    .nodePointerAreaPaint((n, color, ctx) => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, v.radius(n) + 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    })
    .onRenderFramePost((ctx, scale) => drawLabels2d(ctx, scale, g.graphData().nodes))
    .linkColor(v.linkColor)
    .linkWidth(v.linkWidth)
    .linkLineDash(null)
    // arestas levemente curvas: com muitas ligações, linhas retas sobrepostas viram uma malha
    .linkCurvature((l) => (l.kind === "link" ? 0 : 0.12))
    .linkLabel(linkLabel);
  setLinkForces(g);
  g.graphData({ nodes, links });
}

/* ---------------------------------------------------------------- renderizador 3D (WebGL) */

function create3dGraph(el) {
  const g = ForceGraph3D({ controlType: "orbit" })(el)
    .backgroundColor("rgba(0,0,0,0)")
    .showNavInfo(false)
    .nodeId("id")
    .nodeRelSize(4)
    .nodeOpacity(0.95)
    .nodeResolution(16)
    .linkOpacity(1) // a opacidade vem do alpha de cada cor (linkColor)
    .cooldownTicks(120)
    .onNodeHover((n) => {
      state.hoverNode = n || null;
      el.style.cursor = n ? "pointer" : "";
      refreshGraphStyles();
    })
    .onNodeClick((n) => onGraphNodeClick(n))
    .onBackgroundClick(() => closePanel())
    .onEngineStop(() => {
      if (state.graphNeedsFit) {
        state.graphNeedsFit = false;
        fitGraph();
      }
    });
  g.d3Force("charge").strength(-140);
  const resize = () => g.width(el.clientWidth).height(el.clientHeight);
  resize();
  state.graphObserver = new ResizeObserver(resize);
  state.graphObserver.observe(el);
  return g;
}

function draw3d(g, nodes, links) {
  const v = view;
  g.nodeVal((n) => (v.radius(n) / 4) ** 3)
    .nodeColor(v.nodeColor)
    // no 3D o título aparece no hover (tooltip): rótulo fixo em WebGL poluiria a cena
    .nodeLabel((n) => {
      const deg = v.degree.get(n.id) || 0;
      return `<strong>${escHtml(n.label)}</strong><br><span class="muted">${escHtml(n.collection)} · ${t("graph.connections", { count: deg })}</span>`;
    })
    .linkColor(v.linkColor)
    .linkWidth(v.linkWidth)
    // curva em WebGL vira tubo segmentado: só vale a pena com poucas arestas
    .linkCurvature((l) => (l.kind === "link" || links.length > 300 ? 0 : 0.12))
    .linkLabel(linkLabel);
  setLinkForces(g);
  g.graphData({ nodes, links });
}

/* ---------------------------------------------------------------- desenho */

function linkLabel(l) {
  const sim = l.similarity != null ? t("edge.similarity", { value: Number(l.similarity).toFixed(2) }) : "";
  if (l.kind !== "link") return sim;
  const how = l.link_kinds?.includes("wikilink") ? "[[wikilink]]" : t("edge.manual");
  return [t("edge.explicit", { how }), l.note ? `“${escHtml(l.note)}”` : "", sim].filter(Boolean).join("<br>");
}

// documentos ligados explicitamente ficam mais perto que os só parecidos
function setLinkForces(g) {
  g.d3Force("link")
    .distance((l) => (l.kind === "link" ? 45 : 95))
    .strength((l) => (l.kind === "link" ? 0.7 : 0.2));
}

function drawGraph(data) {
  const el = document.getElementById("graph-canvas");
  document.getElementById("graph-empty").classList.add("hidden");

  view = buildView(data);
  const clearBtn = document.getElementById("hl-clear");
  clearBtn.classList.toggle("hidden", !view.highlight);
  if (view.highlight) clearBtn.querySelector("span").textContent = t("graph.clearHighlightN", { count: view.highlight.size });

  const nodes = data.nodes.map((n) => ({
    ...n,
    color: colorFor(n.collection),
    label: state.level === "documents" ? n.title : `${n.title} · #${n.chunk_index}`,
  }));
  const linkEdges = data.edges.filter((e) => e.kind === "link");
  const semanticEdges = data.edges.filter((e) => e.kind === "semantic");
  document.getElementById("graph-sub").textContent = t("graph.sub", {
    nodes: nodes.length,
    links: linkEdges.length,
    semantic: semanticEdges.length,
    level: state.level === "documents" ? t("graph.levelDocuments") : t("graph.levelChunks"),
  });

  // instância do modo errado (troca 2D ↔ 3D): recria
  if (state.graphInstance && state.graphInstanceMode !== state.graphMode) {
    destroyGraph();
    el.innerHTML = "";
  }
  if (!state.graphInstance) {
    state.graphInstance = state.graphMode === "3d" ? create3dGraph(el) : create2dGraph(el);
    state.graphInstanceMode = state.graphMode;
  }
  state.hoverNode = null;
  state.graphNeedsFit = true;
  const links = view.visibleEdges.map((e) => ({ ...e }));
  if (state.graphMode === "3d") draw3d(state.graphInstance, nodes, links);
  else draw2d(state.graphInstance, nodes, links);

  const legend = document.getElementById("graph-legend");
  const plural = (count) => t(state.level === "documents" ? "legend.docs" : "legend.chunks", { count });
  legend.innerHTML = `
    <div class="legend-head">${t("legend.collections")}</div>
    ${data.collections
      .map(
        (c) => `
      <button class="legend-row ${state.collection === c.name ? "active" : ""}" type="button" data-col="${escHtml(c.name)}"
        title="${state.collection === c.name ? t("legend.filtered") : t("legend.clickToFilter")}">
        <span class="dot" style="background:${colorFor(c.name)}"></span>
        <span class="legend-name">${escHtml(c.name)}</span>
        <span class="count">${plural(c.count)}</span>
      </button>`,
      )
      .join("")}
    ${state.collection ? `<button class="legend-all" type="button" data-col="">${icon("x", 12)}<span>${t("legend.allCollections")}</span></button>` : ""}
    ${
      state.level === "documents"
        ? `<div class="legend-head legend-sep">${t("legend.connections")}</div>
      <div class="legend-edge"><span class="edge-swatch link"></span><span class="legend-name">${t("legend.explicit")}</span>
        <span class="count">${linkEdges.length}</span></div>
      <button class="legend-edge toggle ${state.showSemantic ? "" : "off"}" type="button" data-toggle-semantic
        title="${state.showSemantic ? t("legend.hideSemantic") : t("legend.showSemantic")}">
        <span class="edge-swatch semantic"></span><span class="legend-name">${t("legend.similarity")}</span>
        <span class="count">${state.showSemantic ? semanticEdges.length : t("legend.hidden")}</span></button>`
        : ""
    }`;
  loadIcons(legend);
  for (const id of ["graph-legend", "graph-hint", "graph-zoom"]) document.getElementById(id).classList.remove("hidden");
}

// centraliza o nó no grafo (se o grafo estiver aberto) ao navegar por um link do painel
function focusGraphNode(docId) {
  const g = state.graphInstance;
  const node = g?.graphData().nodes.find((n) => n.id === docId);
  if (!node) return;
  if (state.graphInstanceMode === "3d") {
    // câmera a uma distância fixa do nó, olhando para ele
    const dist = 140;
    const len = Math.hypot(node.x, node.y, node.z) || 1;
    const k = 1 + dist / len;
    g.cameraPosition({ x: node.x * k, y: node.y * k, z: node.z * k }, node, 800);
    return;
  }
  g.centerAt(node.x, node.y, 500);
}

// modo conectar no grafo: 1º clique = origem (destacada), 2º = destino (abre o modal já preenchido)
function setConnectMode(on) {
  state.connectMode = on;
  state.connectFrom = null;
  const btn = document.getElementById("connect-mode");
  btn?.classList.toggle("active", on);
  btn?.classList.toggle("ghost", !on);
  connectNotice(on ? t("connect.modeStart") : null);
  refreshGraphStyles();
  if (on) document.addEventListener("keydown", connectEsc);
  else document.removeEventListener("keydown", connectEsc);
}

const connectEsc = (e) => e.key === "Escape" && setConnectMode(false);

function connectNotice(html) {
  const notice = document.getElementById("graph-notice");
  if (!notice) return;
  notice.classList.toggle("hidden", !html);
  notice.classList.toggle("connect", Boolean(html));
  notice.innerHTML = html ? `${icon("link", 14)}<span>${html}</span>` : "";
  if (html) loadIcons(notice);
}

function onGraphNodeClick(n) {
  const docId = state.level === "documents" ? n.id : n.document_id;
  if (!state.connectMode) {
    openDocumentPanel(docId);
    return;
  }
  if (!state.connectFrom) {
    state.connectFrom = n;
    connectNotice(t("connect.modeTarget", { title: escHtml(n.title) }));
    refreshGraphStyles();
    return;
  }
  if (state.connectFrom.id === n.id) return;
  const from = state.connectFrom;
  setConnectMode(false);
  openConnectModal({ document_id: from.id, title: from.title }, { document_id: n.id, title: n.title, collection: n.collection });
}

// recarrega/foca o grafo a pedido de outros módulos (links criados pelo painel, p. ex.)
on("graph:reload", () => {
  if (document.getElementById("graph-wrap")) loadGraph();
});
on("graph:focus", ({ docId }) => focusGraphNode(docId));

export { graphTemplate, bindGraphControls, loadGraph, destroyGraph };
