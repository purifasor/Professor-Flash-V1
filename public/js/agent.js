/* Agent workbench: file store, stream parsing, live preview, ZIP export. */
window.PFAgent = (() => {
  const files = new Map(); // path -> { content, isNew }
  let selected = null;
  let lastParsedCount = 0;

  const $ = (id) => document.getElementById(id);
  const els = {
    tree: () => $("fileTree"),
    count: () => $("fileCount"),
    viewName: () => $("fileViewName"),
    viewCode: () => $("fileViewCode"),
    copyBtn: () => $("btnCopyFile"),
    frame: () => $("previewFrame"),
    empty: () => $("previewEmpty"),
    zip: () => $("btnZip"),
  };

  const FILE_RE = /```file:([^\n`]+)\n([\s\S]*?)```/g;

  /* ------------------------------------------------------------ store */
  function reset() {
    files.clear();
    selected = null;
    lastParsedCount = 0;
    syncUI();
    showPreviewEmpty();
  }

  function setFiles(obj) {
    files.clear();
    Object.entries(obj || {}).forEach(([p, content]) =>
      files.set(p, { content, isNew: false })
    );
    lastParsedCount = 0;
    syncUI();
    refreshPreview();
  }

  function getFilesObject() {
    const o = {};
    files.forEach((v, k) => (o[k] = v.content));
    return o;
  }

  function getFilesArray() {
    return [...files.entries()].map(([path, v]) => ({ path, content: v.content }));
  }

  function upsert(path, content, isNew) {
    const p = path.trim();
    if (!p) return false;
    const prev = files.get(p);
    if (prev && prev.content === content) return false;
    files.set(p, { content, isNew: !!isNew || !prev });
    return true;
  }

  /* -------------------------------------------------- stream ingestion */
  // Parse COMPLETE file blocks found so far in the streamed text.
  // Returns array of newly-added paths since the last call.
  function ingestStream(fullText) {
    const matches = [...fullText.matchAll(FILE_RE)];
    const added = [];
    for (let i = lastParsedCount; i < matches.length; i++) {
      const [, p, c] = matches[i];
      if (upsert(p, c.replace(/\n$/, ""), true)) added.push(p.trim());
    }
    lastParsedCount = matches.length;
    if (added.length) {
      syncUI();
      refreshPreview();
    }
    return added;
  }

  // Final parse after stream end (robust; resets counter).
  function ingestFinal(fullText) {
    lastParsedCount = 0;
    const added = ingestStream(fullText);
    if (!files.size) added.push(...fallbackParse(fullText));
    files.forEach((v) => (v.isNew = false));
    syncUI();
    refreshPreview();
    return added;
  }

  // Models sometimes ignore the strict ```file:path protocol. Recover:
  //  - ```some/path.ext fences (info string itself is a filename)
  //  - a lone ```html fence → treat as index.html
  function fallbackParse(text) {
    const added = [];
    const KNOWN = /\.(html?|css|m?js|json|py|md|txt|svg|tsx?|xml|ya?ml|sh)$/i;
    const pathRe = /```([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,6})\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = pathRe.exec(text))) {
      const p = m[1];
      if (!KNOWN.test(p)) continue;
      if (upsert(p, m[2].replace(/\n$/, ""), true)) added.push(p);
    }
    if (!files.size) {
      const hm = text.match(/```(?:html?|HTML)\s*\n([\s\S]*?)```/);
      if (hm && upsert("index.html", hm[1].replace(/\n$/, ""), true)) {
        added.push("index.html");
      }
    }
    return added;
  }

  /* ------------------------------------------------------------ UI */
  function iconFor(p) {
    const ext = (p.split(".").pop() || "").toLowerCase();
    return {
      html: "🌐", htm: "🌐", css: "🎨", js: "⚡", mjs: "⚡", json: "🧾",
      md: "📝", py: "🐍", svg: "🖼", txt: "📄", png: "🖼", jpg: "🖼",
    }[ext] || "📄";
  }

  function syncUI() {
    const tree = els.tree();
    if (!tree) return;
    tree.innerHTML = "";
    const sorted = [...files.keys()].sort();
    sorted.forEach((p) => {
      const f = files.get(p);
      const btn = document.createElement("button");
      btn.className = "file-node" + (f.isNew ? " new" : "") + (p === selected ? " active" : "");
      btn.innerHTML =
        `<span class="f-dot"></span><span>${iconFor(p)} ${escapeHtml(p)}</span>` +
        `<span class="f-size">${formatSize(f.content.length)}</span>`;
      btn.onclick = () => selectFile(p);
      tree.appendChild(btn);
    });
    els.count().textContent = files.size;
    els.zip().disabled = files.size === 0;
    if (selected && !files.has(selected)) {
      selected = null;
      els.viewName().textContent = "فایلی انتخاب نشده";
      els.viewCode().textContent = "روی یک فایل بزن تا محتواش را ببینی.";
      els.copyBtn().hidden = true;
    }
  }

  function selectFile(p) {
    selected = p;
    const f = files.get(p);
    if (!f) return;
    els.viewName().textContent = p;
    const codeEl = els.viewCode();
    const ext = (p.split(".").pop() || "").toLowerCase();
    const langMap = { htm: "html" };
    codeEl.innerHTML = PFMD.highlight(f.content, langMap[ext] || ext);
    els.copyBtn().hidden = false;
    syncUI();
    switchTab("files");
  }

  function copySelected() {
    if (!selected) return;
    navigator.clipboard
      .writeText(files.get(selected).content)
      .then(() => PFApp.toast("کپی شد ✓"));
  }

  /* ------------------------------------------------------------ preview */
  function resolvePath(baseDir, ref) {
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith("data:")) return ref;
    let parts = (baseDir ? baseDir.split("/") : []).concat(ref.split("/"));
    const out = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  function findEntryHtml() {
    if (files.has("index.html")) return "index.html";
    for (const p of files.keys()) if (/^index\.html?$/i.test(p)) return p;
    for (const p of files.keys()) if (/\.html?$/i.test(p)) return p;
    return null;
  }

  function buildPreviewDoc() {
    const entry = findEntryHtml();
    if (!entry) return null;
    const dir = entry.split("/").slice(0, -1).join("/");
    let doc = files.get(entry).content;

    // normalize root-absolute refs ("/js/app.js" → "js/app.js") so generated
    // apps that ignore the relative-path rule still resolve against the
    // virtual file system instead of leaking to the host origin
    doc = doc.replace(/\b(src|href)=["']\/(?!\/)/gi, '$1="');

    doc = doc.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel=["']?stylesheet/i.test(tag)) return tag;
      const m = tag.match(/href=["']([^"']+)["']/i);
      if (!m) return tag;
      const ref = m[1];
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("data:")) return tag;
      const p = resolvePath(dir, ref);
      const f = files.get(p);
      // unresolved local refs are neutralized (never fetch the host app)
      return f
        ? `<style data-src="${p}">\n${f.content}\n</style>`
        : `<style data-dead="${p}"></style>`;
    });

    doc = doc.replace(
      /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
      (tag, _a, src) => {
        if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:")) return tag;
        const p = resolvePath(dir, src);
        const f = files.get(p);
        return f
          ? `<script data-src="${p}">\n${f.content}\n</script>` // inlined
          : `<script data-dead="${p}"></script>`;
      }
    );
    return doc;
  }

  function refreshPreview() {
    const doc = buildPreviewDoc();
    const frame = els.frame();
    const empty = els.empty();
    if (!frame || !empty) return;
    if (!doc) {
      if (files.size) {
        empty.querySelector("p").innerHTML =
          "فایل‌ها ساخته شدند ولی فایل HTML برای پیش‌نمایش نیست.<br>پیش‌نمایش زنده فقط برای برنامه‌های وب (دارای index.html) فعال می‌شود.";
      }
      showPreviewEmpty();
      return;
    }
    empty.hidden = true;
    frame.hidden = false;
    frame.srcdoc = doc;
  }

  function showPreviewEmpty() {
    const frame = els.frame();
    const empty = els.empty();
    if (frame) frame.hidden = true;
    if (empty) empty.hidden = false;
  }

  /* ------------------------------------------------------------ zip */
  async function downloadZip() {
    if (!files.size) return;
    const zip = new JSZip();
    files.forEach((v, p) => zip.file(p, v.content));
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "professor-flash-project.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    PFApp.toast("فایل ZIP دانلود شد ⬇");
  }

  /* ------------------------------------------------------------ misc */
  function switchTab(name) {
    document.querySelectorAll(".bench-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name)
    );
    $("paneFiles").classList.toggle("active", name === "files");
    $("panePreview").classList.toggle("active", name === "preview");
    if (name === "preview") refreshPreview();
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function formatSize(n) {
    return n < 1024 ? n + "B" : (n / 1024).toFixed(1) + "K";
  }

  function hasFiles() {
    return files.size > 0;
  }

  /* ------------------------------------------------------------ wire */
  document.addEventListener("DOMContentLoaded", () => {
    $("tabFiles").onclick = () => switchTab("files");
    $("tabPreview").onclick = () => switchTab("preview");
    $("btnRefreshPreview").onclick = () => {
      refreshPreview();
      PFApp.toast("پیش‌نمایش تازه شد ↻");
    };
    $("btnZip").onclick = downloadZip;
    els.copyBtn().onclick = copySelected;
  });

  return {
    reset, setFiles, getFilesObject, getFilesArray,
    ingestStream, ingestFinal, refreshPreview, hasFiles,
    switchTab, downloadZip,
  };
})();
