# Knowledge: Zero-Build Web Apps (preview-compatible)

- Entry: `index.html` at root. Reference `css/…` and `js/…` with RELATIVE paths.
- The live preview inlines local `<link rel="stylesheet" href>` and
  `<script src>` files automatically — keep them relative so they resolve.
  The preview auto-reloads whenever the agent updates files.
- CDN (jsdelivr) is allowed for: three.js@0.160.0, chart.js, anime.js,
  confetti, marked, highlight.js. Always pin versions.
- No build tools, no node_modules, no absolute `/...` paths, no external
  fonts beyond Google Fonts / jsdelivr CSS.
- State: localStorage for persistence (shimmed in the preview). No backend
  calls unless the user provides an API.
- Canvas games: set canvas.width/height = CSS size × devicePixelRatio for
  crisp rendering; fixed logical resolution + scale-to-fit;
  requestAnimationFrame loop; delta-time physics; keyboard AND touch
  controls.
- Three.js minimal FPS rig: `THREE.Scene` + fog, `PerspectiveCamera`,
  `WebGLRenderer({antialias:true})`, ambient + directional light, movement
  via camera-space vectors (W = forward, never inverted), `Raycaster` for
  hits, HUD as DOM overlay, clock delta in the loop.
- Charts/dashboards: dark-theme aware palettes; tooltips; responsive resize.
