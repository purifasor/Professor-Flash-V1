/* Markdown pipeline: marked + highlight.js + DOMPurify, RTL-friendly. */
window.PFMD = (() => {
  const hasMarked = typeof marked !== "undefined";
  const hasHljs = typeof hljs !== "undefined";
  const hasPurify = typeof DOMPurify !== "undefined";

  if (hasMarked) {
    marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlight(code, lang) {
    if (hasHljs && lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch { /* fall through */ }
    }
    if (hasHljs) {
      try {
        return hljs.highlightAuto(code).value;
      } catch { /* fall through */ }
    }
    return esc(code);
  }

  function render(src) {
    if (!hasMarked) return "<p>" + esc(src) + "</p>";

    const renderer = new marked.Renderer();

    renderer.code = (code, info) => {
      info = (info || "").trim();
      let lang = info;
      let filePath = null;
      if (info.startsWith("file:")) {
        filePath = info.slice(5).trim();
        const ext = (filePath.split(".").pop() || "").toLowerCase();
        lang = { html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript",
          json: "json", py: "python", md: "markdown", ts: "typescript", svg: "xml",
          txt: "plaintext", sh: "bash", yml: "yaml" }[ext] || ext || "plaintext";
      }
      const label = filePath
        ? `<span class="file-badge">📄 ${esc(filePath)}</span>`
        : `<span>${esc(lang || "code")}</span>`;
      const body = highlight(code, filePath ? lang : info.split(/\s+/)[0]);
      return (
        `<pre><div class="code-head">${label}` +
        `<button class="copy-btn" type="button">کپی</button></div>` +
        `<code class="code-body hljs">${body}</code></pre>`
      );
    };

    renderer.codespan = (code) => `<code>${esc(code)}</code>`;

    const raw = marked.parse(src, { renderer });
    return hasPurify
      ? DOMPurify.sanitize(raw, { ADD_ATTR: ["type"], USE_PROFILES: { html: true } })
      : raw;
  }

  return { render, highlight, esc };
})();
