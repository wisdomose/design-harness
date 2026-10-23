// Design Harness canvas: a chat on the left, a pan-and-zoom canvas on the
// right showing the design file three ways — its design system as a board,
// the page at desktop width and the page at phone width.
//
// The design file is one HTML document. Its `@theme` block is the design
// system; the body is the page, written only in that system's tokens.

const STORAGE_KEY = "dh-project";
const FRAMES = {
  board: { width: 560, viewportHeight: 900 },
  desktop: { width: 1440, viewportHeight: 900 },
  phone: { width: 390, viewportHeight: 844 },
};
const SCREENSHOT_LIB = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/+esm";

const $ = (id) => document.getElementById(id);
const state = { html: "", messages: [], busy: false, abort: null };

// ---------------------------------------------------------------- reading a file

function parseTheme(html) {
  const block = html.match(/@theme\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  const tokens = [];
  for (const m of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    if (m[1].endsWith("*")) continue;
    tokens.push({ name: m[1], value: m[2].trim() });
  }
  return tokens;
}

function titleOf(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : "";
}

function briefOf(html) {
  const m = html.match(/<meta\s+name="design-brief"\s+content="([^"]*)"/i);
  return m ? decodeEntities(m[1]) : "";
}

function decodeEntities(s) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** The document from the first `<!doctype` or `<html`, cut after `</html>`. */
function extractDocument(text) {
  const start = text.search(/<!doctype|<html/i);
  if (start < 0) return "";
  let doc = text.slice(start);
  const end = doc.search(/<\/html>/i);
  if (end >= 0) doc = doc.slice(0, end + "</html>".length);
  return doc;
}

// ---------------------------------------------------------------- frames

// Runs inside each preview. Fixes screen-height units to the frame's
// viewport (the frame grows to the page, so `100vh` would grow with it),
// reports the page height, and takes screenshots on request.
function reporterScript(id, viewportHeight) {
  return `<script>(function(){
var ID=${JSON.stringify(id)},VH=${viewportHeight};
var s=document.createElement('style');
s.textContent='.h-screen,.h-svh,.h-dvh,.h-lvh{height:'+VH+'px!important}.min-h-screen,.min-h-svh,.min-h-dvh,.min-h-lvh{min-height:'+VH+'px!important}.max-h-screen{max-height:'+VH+'px!important}';
(document.head||document.documentElement).appendChild(s);
function size(){var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({dh:'size',id:ID,height:h},'*');}
function ready(){(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){requestAnimationFrame(function(){requestAnimationFrame(function(){size();parent.postMessage({dh:'ready',id:ID},'*');if(window.ResizeObserver&&document.body)new ResizeObserver(size).observe(document.body);});});});}
if(document.readyState==='complete')ready();else addEventListener('load',ready);
addEventListener('message',function(e){if(!e.data||e.data.dh!=='png')return;
import(${JSON.stringify(SCREENSHOT_LIB)}).then(function(m){var el=document.body;return m.toPng(el,{width:el.scrollWidth,height:el.scrollHeight,pixelRatio:1,backgroundColor:getComputedStyle(el).backgroundColor});})
.then(function(url){parent.postMessage({dh:'png',id:ID,url:url},'*');},function(err){parent.postMessage({dh:'png',id:ID,error:String(err)},'*');});});
})();<\/script>`;
}

function withReporter(doc, id, viewportHeight) {
  const script = reporterScript(id, viewportHeight);
  // A document still streaming can stop inside a tag or attribute, which
  // would swallow the script; cut it back to the last complete tag.
  if (!/<\/html>/i.test(doc)) doc = doc.slice(0, doc.lastIndexOf(">") + 1);
  // Font stylesheets must be readable for the PNG export to embed the fonts.
  doc = doc.replace(/<link(?![^>]*crossorigin)([^>]*fonts\.googleapis\.com\/css[^>]*)>/gi, '<link crossorigin="anonymous"$1>');
  const i = doc.search(/<\/body>/i);
  return i >= 0 ? doc.slice(0, i) + script + doc.slice(i) : doc + script;
}

const frameState = {}; // key -> { body, current, pending }
const iframeOwner = new Map(); // iframe id -> frame key
const pngWaiters = new Map(); // iframe id -> resolve

for (const key of Object.keys(FRAMES)) {
  frameState[key] = {
    body: document.querySelector(`[data-frame="${key}"] .frame-body`),
    current: null,
    pending: null,
    queued: null,
  };
}

/**
 * Swaps in a new preview once it has drawn, so updates don't flash blank.
 * While one is still loading, only the newest document waits behind it.
 */
function renderFrame(key, doc) {
  const f = frameState[key];
  if (f.pending) {
    f.queued = doc;
    return;
  }
  const id = Math.random().toString(36).slice(2);
  const iframe = document.createElement("iframe");
  iframe.dataset.id = id;
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.opacity = f.current ? "0" : "1";
  iframe.srcdoc = withReporter(doc, id, FRAMES[key].viewportHeight);
  f.pending = iframe;
  iframeOwner.set(id, key);
  f.body.appendChild(iframe);
  // A preview that never reports (a broken document, a font that never
  // loads) must not hold up the ones behind it.
  setTimeout(() => {
    if (f.pending === iframe) promote(key);
  }, 8000);
}

const heights = new Map(); // iframe id -> last reported page height

window.addEventListener("message", (e) => {
  const data = e.data;
  if (!data || !data.dh) return;
  const key = iframeOwner.get(data.id);
  if (!key) return;
  const f = frameState[key];
  if (data.dh === "size") {
    heights.set(data.id, data.height);
    if (f.current && f.current.dataset.id === data.id) setFrameHeight(key, data.height);
  } else if (data.dh === "ready") {
    if (f.pending && f.pending.dataset.id === data.id) promote(key);
  } else if (data.dh === "png") {
    const resolve = pngWaiters.get(data.id);
    pngWaiters.delete(data.id);
    if (resolve) resolve(data);
  }
});

function promote(key) {
  const f = frameState[key];
  const id = f.pending.dataset.id;
  if (f.current) {
    iframeOwner.delete(f.current.dataset.id);
    heights.delete(f.current.dataset.id);
    f.current.remove();
  }
  f.current = f.pending;
  f.pending = null;
  f.current.style.opacity = "1";
  if (heights.has(id)) setFrameHeight(key, heights.get(id));
  if (f.queued) {
    const next = f.queued;
    f.queued = null;
    renderFrame(key, next);
  }
}

function setFrameHeight(key, height) {
  const min = FRAMES[key].viewportHeight;
  const h = Math.min(Math.max(height, min), 30000);
  frameState[key].body.style.height = `${h}px`;
}

function clearFrames() {
  for (const key of Object.keys(frameState)) {
    const f = frameState[key];
    f.body.innerHTML = "";
    f.current = f.pending = f.queued = null;
    f.body.style.height = `${FRAMES[key].viewportHeight}px`;
  }
  iframeOwner.clear();
  heights.clear();
}

// ---------------------------------------------------------------- the board

function boardDocument(doc) {
  const headEnd = doc.search(/<\/head>/i);
  const theme = parseTheme(doc);
  if (headEnd < 0 || !theme) return null;
  const head = doc.slice(0, headEnd + "</head>".length);
  const name = titleOf(doc) || "Your brand";
  const brief = briefOf(doc);
  const colors = theme.filter((t) => t.name.startsWith("color-"));
  const fonts = theme.filter((t) => t.name.startsWith("font-"));
  const radii = theme.filter((t) => t.name.startsWith("radius-"));
  const label = (s) => `<p class="text-xs font-medium uppercase tracking-[0.18em] text-muted mb-4">${s}</p>`;
  const firstFamily = (v) => v.split(",")[0].replace(/["']/g, "").trim();

  const swatches = colors
    .map((c) => {
      const n = c.name.slice("color-".length);
      return `<div><div class="h-20 rounded-card border border-border bg-${n}"></div>
        <p class="mt-2 text-sm font-semibold">${escapeHtml(n)}</p>
        <p class="text-xs text-muted">${escapeHtml(c.value)}</p></div>`;
    })
    .join("");
  const type = fonts
    .map((f) => {
      const n = f.name.slice("font-".length);
      return `<div class="flex items-baseline gap-6 border-b border-border pb-5">
        <span class="font-${n} text-6xl leading-none">Aa</span>
        <div><p class="font-${n} text-xl">${escapeHtml(firstFamily(f.value))}</p>
        <p class="text-xs text-muted mt-1">${escapeHtml(n)}</p></div></div>`;
    })
    .join("");
  const shapes = radii
    .map((r) => {
      const n = r.name.slice("radius-".length);
      return `<div class="text-center"><div class="h-16 w-16 bg-primary/15 border border-primary rounded-${n}"></div>
        <p class="text-xs text-muted mt-2">${escapeHtml(n)} · ${escapeHtml(r.value)}</p></div>`;
    })
    .join("");

  return `${head}
<body class="bg-background text-text font-body antialiased">
<div class="p-10 flex flex-col gap-12">
  <div>
    ${label("Brand")}
    <h1 class="font-heading text-5xl leading-tight">${escapeHtml(name)}</h1>
    ${brief ? `<p class="mt-3 text-muted leading-relaxed">${escapeHtml(brief)}</p>` : ""}
  </div>
  <section>${label("Colour")}<div class="grid grid-cols-3 gap-4">${swatches}</div></section>
  <section>${label("Type")}<div class="flex flex-col gap-5">${type}
    <p class="text-base leading-relaxed">The quick brown fox jumps over the lazy dog. Body copy sits comfortably at this size and line height.</p>
  </div></section>
  ${shapes ? `<section>${label("Shape")}<div class="flex gap-8">${shapes}</div></section>` : ""}
  <section>${label("Components")}
    <div class="flex flex-wrap gap-3 items-center">
      <button class="bg-primary text-on-primary rounded-button px-6 py-3 font-semibold">Primary action</button>
      <button class="border border-border rounded-button px-6 py-3 font-semibold">Secondary</button>
      <span class="bg-accent/15 text-accent rounded-button px-3 py-1 text-sm font-semibold">Tag</span>
    </div>
    <div class="mt-6 bg-surface border border-border rounded-card p-6">
      <p class="font-heading text-2xl">Card title</p>
      <p class="text-muted mt-2 leading-relaxed">Cards hold products, plans and stories, in the surface colour.</p>
      <div class="mt-5 flex gap-3">
        <input class="flex-1 bg-background border border-border rounded-button px-4 py-3 text-sm" placeholder="Email address">
        <button class="bg-primary text-on-primary rounded-button px-5 font-semibold">Join</button>
      </div>
    </div>
  </section>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------- showing a design

function showDesign(doc, { board = true, page = true } = {}) {
  $("empty").hidden = true;
  $("world").hidden = false;
  if (board) {
    const b = boardDocument(doc);
    if (b) renderFrame("board", b);
  }
  if (page) {
    renderFrame("desktop", doc);
    renderFrame("phone", doc);
  }
  const name = titleOf(doc);
  if (name) $("project-name").textContent = name;
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ html: state.html, messages: state.messages }));
}

// ---------------------------------------------------------------- chat

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = text;
  $("messages").appendChild(el);
  $("messages").scrollTop = $("messages").scrollHeight;
  $("examples").hidden = true;
  return el;
}

function renderMessages() {
  $("messages").innerHTML = "";
  for (const m of state.messages) addMessage(m.role, m.text);
  $("examples").hidden = state.messages.length > 0;
}

function setBusy(busy, status = "") {
  state.busy = busy;
  $("send").disabled = busy;
  $("stop").hidden = !busy;
  $("input").disabled = busy;
  $("status").textContent = status;
}

async function send(text) {
  if (state.busy || !text.trim()) return;
  const isChange = !!state.html;
  state.messages.push({ role: "user", text });
  addMessage("user", text);
  save();
  const agentEl = addMessage("agent", isChange ? "Working on that change…" : "Reading your brief…");
  setBusy(true, "Thinking…");

  const abort = new AbortController();
  state.abort = abort;
  let acc = "";
  let boardShown = false;
  let pageStarted = false;
  let lastRender = 0;
  let failed = null;

  const progress = () => {
    const doc = extractDocument(acc);
    if (!doc) return;
    const themeDone = /<\/style>/i.test(doc) && !!parseTheme(doc);
    const inBody = /<body/i.test(doc);
    if (!themeDone) setBusy(true, "Creating the design system…");
    else if (!/<\/body>/i.test(doc)) setBusy(true, isChange ? "Updating the page…" : "Designing the page…");
    if (isChange) return; // a change replaces the design when it is finished
    if (themeDone && !boardShown) {
      boardShown = true;
      showDesign(doc, { board: true, page: false });
      fit();
      agentEl.textContent = "Design system ready. Designing the page…";
    }
    if (inBody && Date.now() - lastRender > 900) {
      lastRender = Date.now();
      if (!pageStarted) {
        pageStarted = true;
        fit();
      }
      showDesign(doc, { board: false, page: true });
    }
  };

  try {
    const res = await fetch("/api/design", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, html: state.html || null }),
      signal: abort.signal,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error("Signed out. Sign in and send again.");
    }
    if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trimStart();
        }
        if (event === "delta") {
          acc += JSON.parse(data).text;
          progress();
        } else if (event === "error") {
          failed = JSON.parse(data).message;
        }
      }
    }
  } catch (err) {
    failed = abort.signal.aborted ? "Stopped." : err.message;
  }

  state.abort = null;
  const doc = extractDocument(acc);
  if (!failed && !/<\/html>/i.test(doc)) failed = "The designer did not return a complete design. Try again.";

  if (failed) {
    agentEl.className = "message error";
    agentEl.textContent = failed;
    state.messages.push({ role: "error", text: failed });
    // Put the last good design back if a half-made one is showing.
    if (state.html) showDesign(state.html);
  } else {
    state.html = doc;
    showDesign(doc);
    const theme = parseTheme(doc) || [];
    const font = (n) => (theme.find((t) => t.name === `font-${n}`)?.value || "").split(",")[0].replace(/["']/g, "");
    const primary = theme.find((t) => t.name === "color-primary")?.value;
    const summary = isChange
      ? "Done. Ask for another change, or export from the top right."
      : `Done. ${font("heading")} with ${font("body")}${primary ? `, primary colour ${primary}` : ""}. Ask for any change, or export from the top right.`;
    agentEl.textContent = summary;
    state.messages.push({ role: "agent", text: summary });
  }
  save();
  setBusy(false);
  $("input").focus();
}

// ---------------------------------------------------------------- canvas

const view = { x: 80, y: 80, z: 0.4 };
const viewport = $("viewport");
const world = $("world");

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  viewport.style.backgroundSize = `${24 * view.z}px ${24 * view.z}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $("zoom-level").textContent = `${Math.round(view.z * 100)}%`;
}

function zoomAt(px, py, factor) {
  const z = Math.min(Math.max(view.z * factor, 0.05), 4);
  view.x = px - (px - view.x) * (z / view.z);
  view.y = py - (py - view.y) * (z / view.z);
  view.z = z;
  applyView();
}

function zoomCenter(factor) {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, factor);
}

function fit() {
  const r = viewport.getBoundingClientRect();
  let maxX = 0;
  let maxY = 0;
  for (const key of Object.keys(FRAMES)) {
    const el = document.querySelector(`[data-frame="${key}"]`);
    maxX = Math.max(maxX, el.offsetLeft + el.offsetWidth);
    maxY = Math.max(maxY, Math.min(frameState[key].body.offsetHeight, 1400));
  }
  const pad = 48;
  const labelSpace = 40;
  const z = Math.min((r.width - pad * 2) / maxX, (r.height - pad * 2) / (maxY + labelSpace), 1);
  view.z = z;
  view.x = (r.width - maxX * z) / 2;
  view.y = pad + labelSpace * z;
  applyView();
}

viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.01));
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyView();
    }
  },
  { passive: false },
);

const pointers = new Map();
let pinch = null;

viewport.addEventListener("pointerdown", (e) => {
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  viewport.classList.add("panning");
  if (pointers.size === 2) pinch = pinchState();
});

viewport.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    view.x += e.clientX - p.x;
    view.y += e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    applyView();
    return;
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2 && pinch) {
    const next = pinchState();
    const r = viewport.getBoundingClientRect();
    view.x += next.mx - pinch.mx;
    view.y += next.my - pinch.my;
    zoomAt(next.mx - r.left, next.my - r.top, next.dist / pinch.dist);
    pinch = next;
  }
});

function pinchState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) viewport.classList.remove("panning");
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    zoomCenter(1.25);
  } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
    e.preventDefault();
    zoomCenter(0.8);
  } else if (e.shiftKey && e.key === "!") {
    fit();
  }
});

$("zoom-in").onclick = () => zoomCenter(1.25);
$("zoom-out").onclick = () => zoomCenter(0.8);
$("zoom-level").onclick = () => fit();
window.addEventListener("resize", applyView);

// ---------------------------------------------------------------- export and open

function slug() {
  return (titleOf(state.html) || "design").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design";
}

function download(name, href) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  download(name, url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function designSystemCss(html) {
  const theme = parseTheme(html) || [];
  const fontsLink = html.match(/<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/i);
  const lines = theme.map((t) => `  --${t.name}: ${t.value};`).join("\n");
  return `/* ${titleOf(html) || "Design"} — design system exported from Design Harness */
${fontsLink ? `@import url("${fontsLink[1].replace(/&amp;/g, "&")}");\n` : ""}
:root {
${lines}
}
`;
}

async function exportPng(key) {
  const iframe = frameState[key].current;
  if (!iframe) return;
  $("status").textContent = "Making the image…";
  const result = await new Promise((resolve) => {
    pngWaiters.set(iframe.dataset.id, resolve);
    iframe.contentWindow.postMessage({ dh: "png" }, "*");
    setTimeout(() => resolve({ error: "timed out" }), 30000);
  });
  $("status").textContent = "";
  if (result.url) download(`${slug()}-${key}.png`, result.url);
  else alert(`Could not make the image: ${result.error}`);
}

$("export-button").onclick = (e) => {
  e.stopPropagation();
  $("export-menu").hidden = !$("export-menu").hidden;
};
document.addEventListener("click", () => ($("export-menu").hidden = true));
for (const button of document.querySelectorAll("[data-export]")) {
  button.onclick = () => {
    $("export-menu").hidden = true;
    if (!state.html) return alert("There is no design yet.");
    const kind = button.dataset.export;
    if (kind === "html") downloadText(`${slug()}.html`, state.html, "text/html");
    else if (kind === "css") downloadText(`${slug()}-design-system.css`, designSystemCss(state.html), "text/css");
    else if (kind === "png-desktop") exportPng("desktop");
    else if (kind === "png-phone") exportPng("phone");
  };
}

$("open-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const text = await file.text();
  const doc = extractDocument(text);
  if (!doc || !parseTheme(doc)) return alert("That file is not a Design Harness design (it has no @theme design system).");
  state.html = doc;
  state.messages = [{ role: "agent", text: `Opened ${file.name}. Ask for any change.` }];
  renderMessages();
  clearFrames();
  showDesign(doc);
  save();
  setTimeout(fit, 50);
};

$("new-project").onclick = () => {
  if (state.busy) return;
  if (state.html && !confirm("Start a new project? The current design is cleared (export it first to keep it).")) return;
  state.html = "";
  state.messages = [];
  save();
  renderMessages();
  clearFrames();
  $("project-name").textContent = "Untitled";
  $("empty").hidden = false;
  $("world").hidden = true;
};

// ---------------------------------------------------------------- composer and login

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("input").value;
  $("input").value = "";
  send(text);
};
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("stop").onclick = () => state.abort && state.abort.abort();
for (const ex of document.querySelectorAll(".example")) {
  ex.onclick = () => send(ex.textContent);
}

function showLogin() {
  $("app").hidden = true;
  $("login").hidden = false;
  $("login-password").focus();
}

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: $("login-password").value }),
  });
  if (res.ok) {
    $("login-error").hidden = true;
    start();
  } else {
    $("login-error").hidden = false;
  }
};

function start() {
  $("login").hidden = true;
  $("app").hidden = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) {
      state.html = saved.html || "";
      state.messages = saved.messages || [];
    }
  } catch {}
  renderMessages();
  if (state.html) {
    showDesign(state.html);
    setTimeout(fit, 300);
  } else {
    $("world").hidden = true;
  }
  applyView();
  $("input").focus();
}

fetch("/api/me").then((res) => (res.ok ? start() : showLogin()));
