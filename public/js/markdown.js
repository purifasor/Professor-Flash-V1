// Markdown renderer for Professor Flash (marked + DOMPurify + highlight.js).
window.PFMD = (() => {
  let ready = false;

  function init() {
    if (ready || typeof marked === "undefined") return;
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight(code, lang) {
        if (typeof hljs === "undefined") return code;
        try {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return hljs.highlightAuto(code).value;
        } catch {
          return code;
        }
      },
    });
    ready = true;
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Render markdown text → safe HTML with rich code blocks.
   * fileRenderer: optional fn(path) → HTML string replacing ```file:path blocks.
   */
  function render(text, { fileRenderer = null } = {}) {
    init();
    let src = String(text || "");

    // pull out file blocks before markdown so their content stays untouched
    const fileBlocks = [];
    src = src.replace(/```file:([^\n`]+)\n([\s\S]*?)(?:```|$)/g, (_m, p) => {
      fileBlocks.push(p.trim());
      return `\n\nPF_FILE_BLOCK_${fileBlocks.length - 1}\n\n`;
    });

    let html;
    if (typeof marked !== "undefined") {
      html = marked.parse(src);
    } else {
      html = "<p>" + esc(src).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
    }
    if (typeof DOMPurify !== "undefined") {
      html = DOMPurify.sanitize(html, { ADD_ATTR: ["dir"] });
    }

    // restore file blocks as chips (or nothing)
    html = html.replace(/PF_FILE_BLOCK_(\d+)/g, (_m, i) => {
      const p = fileBlocks[+i];
      return fileRenderer ? fileRenderer(p) : "";
    });

    // upgrade plain <pre><code> into rich code-wrap blocks
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code || pre.closest(".code-wrap")) return;
      const lang = (code.className.match(/language-(\S+)/) || [, "code"])[1];
      const wrap = document.createElement("div");
      wrap.className = "code-wrap";
      wrap.innerHTML =
        `<div class="code-head"><span>${esc(lang)}</span>` +
        `<button class="code-copy" type="button">کپی</button></div>`;
      const np = document.createElement("pre");
      const nc = document.createElement("code");
      nc.className = code.className;
      nc.innerHTML = code.innerHTML;
      np.appendChild(nc);
      wrap.appendChild(np);
      pre.replaceWith(wrap);
    });
    // auto dir for paragraphs heavy with latin text
    tmp.querySelectorAll("p, li").forEach((el) => {
      const t = el.textContent || "";
      const latin = (t.match(/[A-Za-z]/g) || []).length;
      const rtl = (t.match(/[\u0600-\u06FF]/g) || []).length;
      if (latin > rtl * 2 && latin > 12) el.setAttribute("dir", "ltr");
    });
    return tmp.innerHTML;
  }

  return { render, esc };
})();
