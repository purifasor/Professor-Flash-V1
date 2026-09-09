// Agent workbench v3: virtual file system, stable blob preview (no srcdoc),
// sandbox-tolerant localStorage shim, live console mirror, auto-fix loop,
// auto-open files/preview after builds, closable file viewer, ZIP export.
//
// v3 upgrades:
//  - preview iframe is scaled to FIT the stage (content never overflows
//    the frame — responsive on every screen)
//  - device switcher keeps real viewport widths (desktop/tablet/mobile)
//  - console shows logs + errors + a "no signal" detector
//  - auto-fix tolerates busy agent (queues instead of looping)
window.PFAgent = (() => {
  const $ = (id) => document.getElementById(id);
  const files = new Map(); // path -> content
  let activeFile = null;
  let previewErrors = [];
  let consoleLines = [];
  let onFixRequest = null; // set by app.js
  let previewUrl = null;
  let lastPreviewHtml = null;
  let previewTimer = null;
  let autoFixInFlight = false;
  let fixCount = 0;
  let busyFlag = false;

  /* ------------------------------------------------ parsing */
  function parseFiles(text, { final = false } = {}) {
    const out = [];
    const re = /```file:([^\n`]+)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text))) {
      out.push({ path: m[1].trim(), content: m[2].replace(/\n$/, "") });
    }
    if (final) {
      const tail = /```file:([^\n`]+)\n([\s\S]*)$/.exec(
        text.replace(/```file:[^\n`]+\n[\s\S]*?```/g, "")
      );
      if (tail && tail[2].trim()) out.push({ path: tail[1].trim(), content: tail[2] });
    }
    return out;
  }

  function validPath(p) {
    return (
      p && !p.includes("..") && !p.startsWith("/") && p.length < 200 &&
      !/```/.test(p) && /\.[a-z0-9]+$/i.test(p)
    );
  }

  /** Feed the full accumulated agent answer; upsert parsed files. */
  function ingest(text, opts = {}) {
    let added = 0;
    let addedPaths = [];
    for (const f of parseFiles(text, opts)) {
      if (!validPath(f.path)) continue;
      if (!files.has(f.path) || files.get(f.path) !== f.content) {
        files.set(f.path, f.content);
        added++;
        addedPaths.push(f.path);
      }
    }
    if (added) {
      renderTree();
      updateCounts();
      if (opts.final) {
        buildPreview();
        // auto-open the first freshly built file in the viewer
        const pick =
          addedPaths.find((p) => p === "index.html") ||
          addedPaths.find((p) => p.endsWith(".html")) ||
          addedPaths[0];
        if (pick) openFile(pick, { silent: true });
      } else {
        schedulePreview();
      }
    } else if (opts.final) {
      buildPreview(); // files may be unchanged, but ensure pane state is right
    }
    return added;
  }

  function reset() {
    files.clear();
    activeFile = null;
    previewErrors = [];
    consoleLines = [];
    lastPreviewHtml = null;
    fixCount = 0;
    autoFixInFlight = false;
    busyFlag = false;
    clearTimeout(previewTimer);
    const frame = $("previewFrame");
    try { frame.src = "about:blank"; } catch { /* noop */ }
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    renderTree();
    updateCounts();
    renderFileView();
    renderConsole();
    showEmpty(true);
    $("previewStage").hidden = true;
    $("previewStatus").hidden = true;
    $("btnFixErrors").hidden = true;
  }

  function getFiles() {
    return [...files.entries()].map(([path, content]) => ({ path, content }));
  }
  function setFiles(list) {
    files.clear();
    (list || []).forEach((f) => f && validPath(f.path) && files.set(f.path, f.content));
    activeFile = null;
    lastPreviewHtml = null;
    renderTree();
    updateCounts();
    renderFileView();
    if (files.size) buildPreview();
    else {
      showEmpty(true);
      $("previewStage").hidden = true;
      $("previewStatus").hidden = true;
    }
  }

  /* ------------------------------------------------ tree + viewer */
  const ICONS = { html: "🌐", css: "🎨", js: "⚙️", json: "🧾", md: "📝", svg: "🖼", png: "🖼", jpg: "🖼", txt: "📄", py: "🐍", cpp: "⚙️", ts: "⚙️" };
  const iconFor = (p) => ICONS[(p.split(".").pop() || "").toLowerCase()] || "📄";

  function renderTree() {
    const tree = $("fileTree");
    const paths = [...files.keys()].sort((a, b) => a.localeCompare(b));
    if (!paths.length) {
      tree.innerHTML = '<div class="tree-empty">No files yet.</div>';
      return;
    }
    const byDir = new Map();
    for (const p of paths) {
      const i = p.lastIndexOf("/");
      const dir = i === -1 ? "" : p.slice(0, i);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
    }
    let html = "";
    for (const [dir, list] of byDir) {
      if (dir) html += `<div class="tree-folder">📁 ${PFMD.esc(dir)}/</div>`;
      for (const p of list) {
        const name = p.split("/").pop();
        html += `<button class="tree-item${p === activeFile ? " active" : ""}" data-path="${PFMD.esc(p)}" title="${PFMD.esc(p)}">
          <span class="fi">${iconFor(p)}</span><span>${PFMD.esc(name)}</span></button>`;
      }
    }
    tree.innerHTML = html;
    tree.querySelectorAll(".tree-item").forEach((b) =>
      b.addEventListener("click", () => openFile(b.dataset.path))
    );
  }

  function renderFileView() {
    const view = $("fileView");
    const name = $("fileViewName");
    const code = $("fileViewCode");
    const placeholder = $("fvPlaceholder");
    const has = activeFile && files.has(activeFile);
    view.classList.toggle("placeholder", !has);
    $("btnCopyFile").hidden = !has;
    $("btnCloseFile").hidden = !has;
    if (!has) {
      name.textContent = "No file selected";
      code.textContent = "";
      code.className = "";
      placeholder.style.display = "";
      return;
    }
    placeholder.style.display = "none";
    name.textContent = activeFile;
    const ext = (activeFile.split(".").pop() || "").toLowerCase();
    const content = files.get(activeFile) || "";
    // empty file → visible warning instead of a blank viewer
    if (!content.trim()) {
      code.textContent = "// ⚠ Empty file — the agent has not written its content yet.";
      code.className = "";
      return;
    }
    code.textContent = content;
    code.className = "language-" + ext;
    if (window.hljs) {
      try {
        delete code.dataset.highlighted; // allow re-highlight after content swap
        hljs.highlightElement(code);
      } catch { /* noop */ }
    }
  }

  function openFile(path, { silent = false } = {}) {
    if (!files.has(path)) return false;
    activeFile = path;
    renderTree();
    renderFileView();
    if (!silent) switchTab("files");
    return true;
  }

  function closeFile() {
    if (!activeFile) return;
    activeFile = null;
    renderTree();
    renderFileView();
    // after closing, show the preview tab again (the viewer is file-scoped)
    if (!$("panePreview").hidden) return;
    switchTab("preview");
  }

  function updateCounts() {
    const n = String(files.size);
    $("fileCount").textContent = n;
    $("fabCount").textContent = n;
    $("btnZip").disabled = !files.size;
    $("btnOpenPreview").disabled = !files.size;
  }

  function showEmpty(show) {
    $("previewEmpty").style.display = show ? "flex" : "none";
  }

  /* ------------------------------------------------ runtime shim */
  // Injected as the FIRST <head> script: lets sandboxed documents use
  // localStorage/sessionStorage (in-memory) and keeps console.* observable.
  // Also patches CDN font links to their correct MIME-typed URLs so Vazirmatn
  // loads inside the preview (jsdelivr npm path, not the blocked gh path).
  const RUNTIME_SHIM = `<script>
(function () {
  try { window.localStorage.getItem("x"); } catch (e) {
    var mem = {};
    var mk = function () {
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, String(k)) ? mem[String(k)] : null; },
        setItem: function (k, v) { mem[String(k)] = String(v); },
        removeItem: function (k) { delete mem[String(k)]; },
        clear: function () { mem = {}; },
        key: function (i) { var ks = Object.keys(mem); return i < ks.length ? ks[i] : null; },
        get length() { return Object.keys(mem).length; },
      };
    };
    try {
      Object.defineProperty(window, "localStorage", { value: mk(), configurable: true });
      Object.defineProperty(window, "sessionStorage", { value: mk(), configurable: true });
    } catch (e2) { /* non-configurable in some engines — best effort */ }
  }
  function send(type, msg) {
    try { parent.postMessage({ pf: "preview", type: type, message: String(msg).slice(0, 500) }, "*"); } catch (e) {}
  }
  window.addEventListener("error", function (e) {
    send("error", (e.message || "error") + " @" + String(e.filename || "").split("/").pop() + ":" + (e.lineno || ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    send("error", "unhandled: " + (e.reason && (e.reason.message || e.reason) || "promise"));
  });
  ["log", "warn", "error", "info"].forEach(function (m) {
    var orig = console[m] ? console[m].bind(console) : function () {};
    console[m] = function () {
      send(m === "warn" || m === "error" ? "error" : "log",
        [].map.call(arguments, function (a) {
          try { return typeof a === "object" ? JSON.stringify(a).slice(0, 200) : String(a); } catch (e) { return "[?]"; }
        }).join(" "));
      orig.apply(null, arguments);
    };
  });
  window.addEventListener("load", function () { send("ready", "loaded"); });
})();
<\/script>`;

  const FONT_FIXES = [
    // wrong-version / wrong-file paths → the working font-face css
    [
      "cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css",
      "cdn.jsdelivr.net/npm/vazirmatn@33.0.3/Vazirmatn-font-face.css",
    ],
    [
      "cdn.jsdelivr.net/npm/vazirmatn@33.003/Vazirmatn.min.css",
      "cdn.jsdelivr.net/npm/vazirmatn@33.0.3/Vazirmatn-font-face.css",
    ],
  ];

  function fixFontLinks(html) {
    for (const [from, to] of FONT_FIXES) {
      html = html.split(from).join(to);
    }
    return html;
  }

  /* ------------------------------------------------ preview */
  function isLocalRef(u) {
    return u && !/^(https?:)?\/\//i.test(u) && !u.startsWith("data:") && !u.startsWith("#");
  }

  function findEntry() {
    let entry = null;
    for (const p of files.keys()) if (p.toLowerCase() === "index.html") entry = p;
    if (!entry) for (const p of files.keys()) if (p.endsWith(".html")) entry = p;
    return entry;
  }

  function buildHtml() {
    const entry = findEntry();
    if (!entry) return null;
    let html = files.get(entry);
    const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
    const resolve = (ref) => {
      const parts = (dir + ref).split("/").filter((s) => s && s !== ".");
      const out = [];
      for (const s of parts) s === ".." ? out.pop() : out.push(s);
      return out.join("/");
    };

    // inline local stylesheets
    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      const rel = (tag.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
      if (!href || !isLocalRef(href) || !/stylesheet|\.css$/i.test(rel + href)) return tag;
      const p = resolve(href);
      return files.has(p) ? `<style data-src="${p}">\n${files.get(p)}\n</style>` : tag;
    });

    // inline local scripts (keep execution order; preserve type)
    html = html.replace(
      /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
      (tag, pre, src, post) => {
        if (!isLocalRef(src)) return tag;
        const p = resolve(src);
        if (!files.has(p)) return tag;
        const attrs = (pre + " " + post).replace(/\b(src|type)\s*=\s*["'][^"']*["']/gi, "").trim();
        return `<script ${attrs} data-src="${p}">\n${files.get(p)}\n<\/script>`;
      }
    );

    html = fixFontLinks(html);

    // runtime shim right after <head> (or at top) — before any user script
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + "\n" + RUNTIME_SHIM);
    else html = RUNTIME_SHIM + html;
    return html;
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(buildPreview, 900);
  }

  /** Fit the device frame to the stage — content always inside the box. */
  function fitPreview() {
    const stage = $("previewStage");
    const device = stage.querySelector(".preview-device");
    if (!stage || !device || stage.hidden) return;
    const d = stage.dataset.device || "desktop";
    const pad = 32;
    const availW = stage.clientWidth - pad;
    const availH = stage.clientHeight - pad;
    let targetW = Math.max(320, availW); // desktop fills
    if (d === "tablet") targetW = Math.min(820, availW);
    if (d === "mobile") targetW = Math.min(390, availW);
    device.style.width = Math.floor(targetW) + "px";
    device.style.height = Math.floor(Math.max(240, availH)) + "px";
  }

  function buildPreview() {
    clearTimeout(previewTimer);
    const html = buildHtml();
    const status = $("previewStatus");

    if (!html) {
      // files may exist but none is an html entry → nothing runnable yet
      if (files.size) {
        showEmpty(true);
        $("previewStage").hidden = true;
        status.hidden = false;
        status.classList.remove("ok", "err");
        status.textContent = "no index.html yet — files live in the FILES tab";
      }
      return;
    }

    // unchanged → never touch the iframe (zero flicker)
    if (html === lastPreviewHtml) {
      showEmpty(false);
      $("previewStage").hidden = false;
      fitPreview();
      return;
    }
    lastPreviewHtml = html;

    previewErrors = [];
    consoleLines = [];
    renderConsole();
    $("btnFixErrors").hidden = true;
    status.hidden = false;
    status.classList.remove("ok", "err");
    status.textContent = "building preview… " + new Date().toLocaleTimeString();

    showEmpty(false);
    $("previewStage").hidden = false;
    fitPreview();

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const frame = $("previewFrame");
    frame.src = previewUrl; // blob URL → real document load, scripts run

    // blob documents are async — wait for the ready/first-error signal
    waitForPreview(8000).then((ok) => {
      if (ok) return;
      // no signal at all: the frame may be blank/blocked. Offer a rebuild hint.
      status.hidden = false;
      status.classList.remove("ok");
      status.textContent = "preview sent — no runtime signal (app may be static)";
    });
  }

  let readyWaiter = null;
  function waitForPreview(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      readyWaiter = () => done(true);
    });
  }

  // messages from the preview iframe
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.pf !== "preview") return;
    if (readyWaiter) { const w = readyWaiter; readyWaiter = null; w(true); }
    const status = $("previewStatus");
    if (d.type === "error") {
      previewErrors.push(d.message);
      pushConsole("error", d.message);
      status.classList.remove("ok");
      status.classList.add("err");
      status.textContent = "⚠ " + previewErrors.slice(-3).join("\n⚠ ");
      $("btnFixErrors").hidden = false;
      maybeAutoFix();
    } else if (d.type === "log") {
      pushConsole("log", d.message);
    } else if (d.type === "ready") {
      status.classList.remove("err");
      status.classList.add("ok");
      status.textContent =
        "running · " + files.size + " file(s) · " + new Date().toLocaleTimeString();
      // a clean load after a fix run clears the fix flag
      if (autoFixInFlight && !previewErrors.length) autoFixInFlight = false;
    }
  });

  /* ------------------------------------------------ console mirror */
  function pushConsole(level, text) {
    consoleLines.push({ level, text: String(text).slice(0, 400), at: Date.now() });
    if (consoleLines.length > 200) consoleLines.shift();
    renderConsole();
  }

  function renderConsole() {
    const box = $("consoleBox");
    if (!box) return;
    const errCount = consoleLines.filter((l) => l.level === "error").length;
    const logCount = consoleLines.length - errCount;
    const badge = $("consoleCount");
    if (badge) {
      badge.textContent = consoleLines.length ? String(consoleLines.length) : "0";
    }
    const cn = $("tabConsole").querySelector(".file-count");
    if (cn) {
      cn.textContent = errCount ? String(errCount) : (logCount ? String(logCount) : "0");
      cn.classList.toggle("has-err", errCount > 0);
    }
    if (!consoleLines.length) {
      box.innerHTML = '<div class="con-line muted">Console is empty — live app output appears here.</div>';
      return;
    }
    box.innerHTML = consoleLines
      .map(
        (l) =>
          `<div class="con-line ${l.level}">${l.level === "error" ? "✖" : "›"} ${PFMD.esc(l.text)}</div>`
      )
      .join("");
    box.scrollTop = box.scrollHeight;
  }

  function clearConsole() {
    consoleLines = [];
    renderConsole();
  }

  /* ------------------------------------------------ auto-fix loop */
  // When the preview reports errors and the agent is idle, automatically ask
  // it to repair (max 2 auto passes per build to avoid loops). If the agent
  // is busy, wait for it to finish — the fix request is not lost.
  function maybeAutoFix() {
    if (autoFixInFlight || fixCount >= 2) return;
    if (!previewErrors.length) return;
    // wait a moment so batched errors collect first
    clearTimeout(maybeAutoFix._t);
    maybeAutoFix._t = setTimeout(() => {
      if (autoFixInFlight || fixCount >= 2 || !previewErrors.length) return;
      if (busyFlag) {
        // agent busy — retry after it finishes (poll, don't drop the fix)
        maybeAutoFix._t = setTimeout(maybeAutoFix, 1500);
        return;
      }
      autoFixInFlight = true;
      fixCount++;
      if (onFixRequest) onFixRequest([...new Set(previewErrors)].slice(0, 8));
    }, 1600);
  }

  /* ------------------------------------------------ zip */
  async function downloadZip() {
    if (!files.size || typeof JSZip === "undefined") return;
    const zip = new JSZip();
    for (const [p, c] of files) zip.file(p, c);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "professor-flash-project.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    PFApp && PFApp.toast && PFApp.toast("ZIP downloaded ⬇");
  }

  /* ------------------------------------------------ tabs & wiring */
  function switchTab(name) {
    for (const t of ["preview", "files", "console"]) {
      $("tab" + t[0].toUpperCase() + t.slice(1)).classList.toggle("active", name === t);
      $("pane" + t[0].toUpperCase() + t.slice(1)).hidden = name !== t;
    }
    if (name === "preview") fitPreview();
  }

  function init() {
    $("tabPreview").addEventListener("click", () => switchTab("preview"));
    $("tabFiles").addEventListener("click", () => switchTab("files"));
    $("tabConsole").addEventListener("click", () => switchTab("console"));
    $("btnRefreshPreview").addEventListener("click", () => {
      lastPreviewHtml = null;
      fixCount = 0;
      previewErrors = [];
      renderConsole();
      buildPreview();
    });
    $("btnZip").addEventListener("click", downloadZip);
    $("btnOpenPreview").addEventListener("click", () => {
      if (previewUrl) window.open(previewUrl, "_blank");
    });
    $("btnCopyFile").addEventListener("click", async () => {
      if (!activeFile) return;
      try {
        await navigator.clipboard.writeText(files.get(activeFile) || "");
        PFApp && PFApp.toast && PFApp.toast("Copied ✓");
      } catch { /* clipboard unavailable */ }
    });
    $("btnCloseFile").addEventListener("click", closeFile);
    $("btnClearConsole").addEventListener("click", clearConsole);
    $("btnFixErrors").addEventListener("click", () => {
      if (onFixRequest && previewErrors.length && !busyFlag) {
        const errs = [...new Set(previewErrors)].slice(0, 8);
        autoFixInFlight = true;
        fixCount++;
        onFixRequest(errs);
      }
    });
    $("benchFab").addEventListener("click", () => {
      $("bench").classList.toggle("mobile-open");
      fitPreview();
    });

    // device size switcher + responsive fit
    $("devSwitch").querySelectorAll(".dev-btn").forEach((b) =>
      b.addEventListener("click", () => {
        $("devSwitch").querySelectorAll(".dev-btn").forEach((x) => x.classList.toggle("active", x === b));
        $("previewStage").dataset.device = b.dataset.device;
        fitPreview();
      })
    );
    window.addEventListener("resize", () => {
      if (!$("previewStage").hidden) fitPreview();
    });

    // Esc closes the open file (and the mobile workbench)
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("bench").classList.contains("mobile-open")) {
        $("bench").classList.remove("mobile-open");
        return;
      }
      closeFile();
    });

    renderTree();
    renderFileView();
    renderConsole();
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    ingest, reset, getFiles, setFiles, parseFiles, buildPreview, switchTab, openFile,
    pushConsole, fitPreview,
    get errors() { return previewErrors; },
    set onFixRequest(fn) { onFixRequest = fn; },
    openMobile() { $("bench").classList.add("mobile-open"); fitPreview(); },
    setBusy(on) { busyFlag = !!on; autoFixInFlight = !!on ? autoFixInFlight : false; },
    busy() { return busyFlag; },
  };
})();
