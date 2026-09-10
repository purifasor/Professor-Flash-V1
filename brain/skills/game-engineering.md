# Skill — Game Engineering (مهندسی بازی)

- Genre first: name the genre (FPS, platformer, RTS, puzzle…), recall its
  core loop and required mechanics, THEN build. «مثل کانتر استرایک» = FPS:
  first-person camera, WASD move, mouse look, left-click fire, right-click
  ADS, enemies, hit detection, HUD, rounds/score.
- Loop: `requestAnimationFrame` + delta-time; fixed-timestep for physics;
  clamp dt (cap at 0.05s). Pause when tab hidden. NEVER advance state by
  frame count.
- **Quality over speed.** Take the time to build it right the first time:
  a finished build must be the actual game, complete and playable — not a
  skeleton "to be improved later". If you have the token budget, spend it
  on the real geometry, the real lighting, the real gameplay.

## 3D core rig (memorize — this is the backbone)
- **Camera = player's eyes.** `PerspectiveCamera(75, aspect, 0.1, 1000)`.
  NEVER rotate the camera itself for look — use a **rig**:
  `player` (Object3D: position + yaw) → `head` (child: pitch, clamped
  ±~89°) → camera. Yaw rotates the player, pitch rotates the head ONLY.
  This prevents the classic "camera spins around itself" bug.
- **Pointer lock mouse look.** Click canvas → `canvas.requestPointerLock()`;
  on `mousemove` while locked: `player.rotation.y -= e.movementX * 0.0022;`
  `head.rotation.x -= e.movementY * 0.0022;` clamp head.rotation.x.
  `pointerlockchange` toggles an overlay ("Click to play"). Exit on Esc is
  automatic — handle it, don't break.
- **WASD in camera space.** Build the move vector from player yaw:
  forward = `(sin(-yaw), 0, cos(-yaw))`… safest: `player.getWorldDirection(v)`,
  zero the Y, normalize → forward; right = forward × up. W = +forward
  (never inverted — W must move toward where the camera LOOKS). Diagonals
  normalized. Apply with `position.addScaledVector(dir, speed * dt)`.
- **Vertical & physics:** simple gravity for jumps (vy -= g*dt), ground
  clamp at eye height (~1.7 for human scale), optional crouch (eye 1.0).
- **Rendering:** `WebGLRenderer({ antialias: true })`, `setPixelRatio(Math.min(devicePixelRatio, 2))`,
  resize handler updating camera.aspect + renderer.setSize. Fog matched to
  the sky color (`scene.fog = new THREE.Fog(bg, near, far)`) — this is what
  keeps scenes looking rich instead of pitch black voids.
- **Lighting design:** ambient (low) + hemisphere + one directional key
  (with shadows for hero props when affordable). No black scenes: verify
  every material has adequate light on it. Emissive materials for lamps,
  screens, neon.

## World building (real geometry, not primitive spam)
- **Human-scale math:** door ~2.1m, ceiling 2.8–3.5m, corridor 1.4–2.5m
  wide, hero room 8–20m. Walls built as `BoxGeometry` slabs with thickness
  (0.1–0.3m), never paper-thin planes.
- **Maps with intent:** sketch the layout first (start room → corridor →
  arena with cover). Cover objects at waist/head height players can duck
  behind. Spawn points away from enemy sightlines. Lock the theme into the
  palette (dark navy base + 2 accents max).
- **Materials & textures:** `MeshStandardMaterial` + procedural canvas
  textures — value-noise for concrete/ground, brick/tile patterns via
  small canvas + `RepeatWrapping`; derive 4–6 shades per material (base,
  shadow, mid, highlight). Roughness consistent per world. Use
  `THREE.Color` tints when a texture is overkill.
- **Props as composition:** crates (boxes), barrels (cylinders), pillars,
  neon strips (emissive thin boxes), wall panels — instanced where possible.
  A room should read as a PLACE, not an empty box.

## Enemies & combat
- Enemies: articulated groups (body + head + limbs as child meshes) with
  state machines (idle → chase → attack → dead), health, and simple
  steering (move toward player, avoid stacking via small random offsets).
- Hit detection: `THREE.Raycaster` from camera center for hitscan; visual
  tracer (fading line) + impact particles + hit flash on the enemy material
  (`emissive` pulse). Headshot bonus when the ray hits the head mesh.
- Player damage → red vignette flash, screen shake (small camera offset
  decaying over ~0.3s), death screen with restart that RESETS state
  cleanly (positions, health, score, enemies).

## HUD & game feel
- HUD as DOM overlay (crosshair, health, ammo, score, wave, minimap when
  fitting) — updated from the loop but throttled (every ~100ms).
- Juice: muzzle flash, hit markers, kill feed, damage numbers, low-HP
  heartbeat vignette. Audio via WebAudio oscillators (no external files).
- First 30 seconds teach controls passively: on-screen key hints fading
  after first use.

## 2D (Canvas)
- Logical resolution + letterbox scale; layered draw order (bg → entities →
  fx → HUD); AABB/circle collisions with verified math; procedural
  sprites/textures; touch controls for mobile (virtual joystick + buttons).

## Input map
- Keyboard: WASD/arrows, Space jump, Shift sprint, R reload, E interact,
  P/Esc pause. Mouse: L fire, R ADS (FOV lerp 75→45), wheel weapon/zoom.
  `preventDefault` on contextmenu inside the canvas. Mobile → virtual
  joystick + fire button.

## Anti-bug checklist (run before emitting)
- [ ] No camera spinning: yaw on player, pitch on head, both clamped.
- [ ] W moves toward the look direction; S back; A/D strafe correctly.
- [ ] Pointer lock overlay exists; game pauses when lock is lost.
- [ ] dt-based movement; tab-hidden pause; no NaNs in transforms.
- [ ] Scene is lit — nothing pure black; fog matches background.
- [ ] Win/lose reachable; restart resets everything; zero console errors.
- [ ] Anti-frustration: no spawn-kill; telegraphed danger.
