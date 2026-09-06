# Knowledge: Zero-Build Web Apps (preview-compatible)

- Entry: `index.html` at root. Reference `css/…` and `js/…` with RELATIVE paths.
- The live preview inlines local `<link rel="stylesheet" href>` and
  `<script src>` files automatically — keep them relative so they resolve.
- CDN (jsdelivr) is allowed for: chart.js, three.js, anime.js, confetti,
  marked, highlight.js. Always pin versions.
- No build tools, no node_modules, no absolute `/...` paths, no external
  fonts beyond Google Fonts / jsdelivr CSS.
- State: localStorage for persistence. No backend calls unless the user
  provides an API.
- Canvas games: fixed logical resolution + scale-to-fit; requestAnimationFrame
  loop; delta-time physics; keyboard AND touch controls.
- Charts/dashboards: dark-theme aware palettes; tooltips; responsive resize.
