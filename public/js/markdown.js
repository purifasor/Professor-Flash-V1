// Markdown renderer for Professor Flash V1 (marked + DOMPurify + highlight.js).
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
        `<button class="code-copy" type="button">Copy</button></div>`;
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

    // render mermaid diagrams (structure explanations) — lazy load
    tmp.querySelectorAll("pre code.language-mermaid").forEach((el) => {
      const preEl = el.closest("pre");
      const src2 = el.textContent;
      const holder = document.createElement("div");
      holder.className = "mermaid-box";
      holder.setAttribute("data-mermaid", src2);
      preEl.replaceWith(holder);
      renderMermaid(holder);
    });

    return tmp.innerHTML;
  }

  async function renderMermaid(holder) {
    try {
      if (typeof mermaid === "undefined") {
        await loadScript("https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js");
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          themeVariables: {
            background: "#0e0d0c",
            primaryColor: "#2a1512",
            primaryTextColor: "#f5f1ef",
            primaryBorderColor: "#a03530",
            lineColor: "#ff5f52",
            secondaryColor: "#1c1917",
            tertiaryColor: "#131110",
            fontFamily: "Vazirmatn, sans-serif",
          },
        });
      }
      const id = "mmd" + Math.random().toString(36).slice(2);
      const { svg } = await mermaid.render(id, holder.getAttribute("data-mermaid"));
      holder.innerHTML = svg;
    } catch {
      const src2 = holder.getAttribute("data-mermaid") || "";
      holder.innerHTML =
        '<pre class="mermaid-fallback" dir="ltr">' + esc(src2) + "</pre>";
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  return { render, esc };
})();
