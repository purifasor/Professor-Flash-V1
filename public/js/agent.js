// Agent workbench: virtual file system, live preview, ZIP export, auto-fix.
window.PFAgent = (() => {
  const $ = (id) => document.getElementById(id);
  const files = new Map(); // path -> content
  let activeFile = null;
  let previewErrors = [];
  let onFixRequest = null; // set by app.js
  let previewUrl = null;

  /* ------------------------------------------------ parsing */
  // Extract COMPLETE ```file:path blocks (during streaming) or also the
  // trailing open block (final pass).
  function parseFiles(text, { final = false } = {}) {
    const out = [];
    const re = /```file:([^\n`]+)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text))) {
      out.push({ path: m[1].trim(), content: m[2].replace(/\n$/, "") });
    }
    if (final) {
      const tail = /```file:([^\n`]+)\n([\s\S]*)$/.exec(text.replace(/```file:[^\n`]+\n[\s\S]*?```/g, ""));
      if (tail && tail[2].trim()) out.push({ path: tail[1].trim(), content: tail[2] });
    }
    return out;
  }

  function validPath(p) {
    return p && !p.includes("..") && !p.startsWith("/") && p.length < 200 &&
      !/```/.test(p) && /\.[a-z0-9]+$/i.test(p);
  }

  /** Feed the full accumulated agent answer; upsert parsed files. */
  function ingest(text, opts = {}) {
    let added = 0;
    for (const f of parseFiles(text, opts)) {
      if (!validPath(f.path)) continue;
      if (!files.has(f.path) || files.get(f.path) !== f.content) {
        files.set(f.path, f.content);
        added++;
      }
    }
    if (added) {
      renderTree();
      updateCounts();
      buildPreview();
    }
    return added;
  }

  function reset() {
    files.clear();
    activeFile = null;
    previewErrors = [];
    renderTree();
    updateCounts();
    showEmpty(true);
    $("previewFrame").hidden = true;
    $("previewStatus").hidden = true;
    $("btnZip").disabled = true;
    $("btnOpenPreview").disabled = true;
    $("btnFixErrors").hidden = true;
  }

  function getFiles() {
    return [...files.entries()].map(([path, content]) => ({ path, content }));
  }
  function setFiles(list) {
    files.clear();
    (list || []).forEach((f) => f && validPath(f.path) && files.set(f.path, f.content));
    activeFile = null;
    renderTree();
    updateCounts();
    if (files.size) buildPreview();
  }

  /* ------------------------------------------------ tree + viewer */
  const ICONS = { html: "🌐", css: "🎨", js: "⚙️", json: "🧾", md: "📝", svg: "🖼", png: "🖼", jpg: "🖼", txt: "📄" };
  const iconFor = (p) => ICONS[(p.split(".").pop() || "").toLowerCase()] || "📄";

  function renderTree() {
    const tree = $("fileTree");
    const paths = [...files.keys()].sort((a, b) => a.localeCompare(b));
    if (!paths.length) {
      tree.innerHTML = '<div class="drawer-empty">هنوز فایلی ساخته نشده.</div>';
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

  function openFile(path) {
    if (!files.has(path)) return;
    activeFile = path;
    $("fileViewName").textContent = path;
    $("btnCopyFile").hidden = false;
    const code = $("fileViewCode");
    const ext = (path.split(".").pop() || "").toLowerCase();
    code.textContent = files.get(path);
    code.className = "language-" + ext;
    if (window.hljs) {
      try { hljs.highlightElement(code); } catch { /* noop */ }
    }
    renderTree();
    switchTab("files");
  }

  function updateCounts() {
    const n = String(files.size);
    $("fileCount").textContent = n;
    $("fabCount").textContent = n;
    $("btnZip").disabled = !files.size;
    $("btnOpenPreview").disabled = !files.size;
    if (files.size) showEmpty(false);
  }

  function showEmpty(show) {
    $("previewEmpty").style.display = show ? "flex" : "none";
  }

  /* ------------------------------------------------ preview */
  const ERROR_HOOK = `<script>
(function(){
  function send(type,msg){ try{ parent.postMessage({pf:'preview',type:type,message:String(msg).slice(0,500)},'*'); }catch(e){} }
  window.addEventListener('error',function(e){ send('error',(e.message||'error')+' @ '+(e.filename||'').split('/').pop()+':'+(e.lineno||'')); });
  window.addEventListener('unhandledrejection',function(e){ send('error','unhandled: '+(e.reason&&(e.reason.message||e.reason)||'promise')); });
  var ce=console.error.bind(console); console.error=function(){ send('error',[].map.call(arguments,String).join(' ')); ce.apply(null,arguments); };
  window.addEventListener('load',function(){ send('ready','loaded'); });
})();
<\/script>`;

  function isLocalRef(u) {
    return u && !/^(https?:)?\/\//i.test(u) && !u.startsWith("data:") && !u.startsWith("#");
  }

  function buildPreview() {
    const frame = $("previewFrame");
    const status = $("previewStatus");
    // pick entry html
    let entry = null;
    for (const p of files.keys()) if (p.toLowerCase() === "index.html") entry = p;
    if (!entry) for (const p of files.keys()) if (p.endsWith(".html")) entry = p;
    if (!entry) return;

    let html = files.get(entry);
    const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
    const resolve = (ref) => {
      // resolve ref relative to entry dir, normalize a/../b
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

    // inline local scripts (keep execution order)
    html = html.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
      if (!isLocalRef(src)) return tag;
      const p = resolve(src);
      if (!files.has(p)) return tag;
      const type = (tag.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
      const isModule = /module/i.test(type);
      return `<script data-src="${p}"${isModule ? ' type="module"' : ""}>\n${files.get(p)}\n<\/script>`;
    });

    // error hook right after <head> (or at top)
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + "\n" + ERROR_HOOK);
    else html = ERROR_HOOK + html;

    previewErrors = [];
    $("btnFixErrors").hidden = true;
    status.hidden = false;
    status.classList.remove("err");
    status.textContent = "building preview… " + new Date().toLocaleTimeString();

    showEmpty(false);
    frame.hidden = false;
    frame.srcdoc = html;

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  }

  // messages from the preview iframe
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.pf !== "preview") return;
    const status = $("previewStatus");
    if (d.type === "error") {
      previewErrors.push(d.message);
      status.classList.add("err");
      status.textContent = "⚠ " + previewErrors.slice(-3).join("\n⚠ ");
      $("btnFixErrors").hidden = false;
    } else if (d.type === "ready") {
      status.classList.remove("err");
      status.textContent = "✓ running · " + files.size + " file(s) · " + new Date().toLocaleTimeString();
    }
  });

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
    PFApp && PFApp.toast && PFApp.toast("فایل ZIP دانلود شد ⬇");
  }

  /* ------------------------------------------------ tabs & wiring */
  function switchTab(name) {
    $("tabPreview").classList.toggle("active", name === "preview");
    $("tabFiles").classList.toggle("active", name === "files");
    $("panePreview").hidden = name !== "preview";
    $("paneFiles").hidden = name !== "files";
  }

  function init() {
    $("tabPreview").addEventListener("click", () => switchTab("preview"));
    $("tabFiles").addEventListener("click", () => switchTab("files"));
    $("btnRefreshPreview").addEventListener("click", buildPreview);
    $("btnZip").addEventListener("click", downloadZip);
    $("btnOpenPreview").addEventListener("click", () => {
      if (previewUrl) window.open(previewUrl, "_blank");
    });
    $("btnCopyFile").addEventListener("click", async () => {
      if (!activeFile) return;
      try {
        await navigator.clipboard.writeText(files.get(activeFile) || "");
        PFApp && PFApp.toast && PFApp.toast("کپی شد ✓");
      } catch { /* clipboard unavailable */ }
    });
    $("btnFixErrors").addEventListener("click", () => {
      if (onFixRequest && previewErrors.length) {
        const errs = [...new Set(previewErrors)].slice(0, 8);
        onFixRequest(errs);
      }
    });
    $("benchFab").addEventListener("click", () => {
      $("bench").classList.toggle("mobile-open");
    });
    renderTree();
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    ingest, reset, getFiles, setFiles, parseFiles, buildPreview, switchTab,
    get errors() { return previewErrors; },
    set onFixRequest(fn) { onFixRequest = fn; },
    openMobile() { $("bench").classList.add("mobile-open"); },
  };
})();
