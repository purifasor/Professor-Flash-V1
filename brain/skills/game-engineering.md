# Skill — Game Engineering (مهندسی بازی)

- Genre first: name the genre (FPS, platformer, RTS, puzzle…), recall its
  core loop and required mechanics, THEN build. «مثل کانتر استرایک» = FPS:
  first-person camera, WASD move, mouse look, left-click fire, right-click
  ADS, enemies, hit detection, HUD, rounds/score.
- Loop: `requestAnimationFrame` + delta-time; fixed-timestep for physics;
  clamp dt. Pause when tab hidden.
- 2D (Canvas): logical resolution + letterbox scaling; layered draw order
  (bg → entities → fx → HUD); collision via AABB/circle with concrete math;
  sprite sheets or procedural canvas textures.
- 3D (Three.js): camera = player's eyes; movement in camera space (W =
  forward — never inverted); `pointerlockchange` for mouse look; raycast for
  shooting; `MeshStandardMaterial` + canvas-generated textures; enemies as
  meshes with health/state; HUD as DOM overlay (crosshair, health, ammo,
  score); dispose properly; cap pixel ratio.
- Input: keyboard map (WASD/arrows/Space/E/P/Esc), mouse buttons (L=fire,
  R=aim/ADS), wheel for zoom/weapon; mobile → virtual joystick + action
  buttons; prevent context menu on right-click in-game.
- Game feel: juice (hit flashes, screen shake, particles, kill feed),
  audio via WebAudio oscillators/samples, difficulty ramp, restartable
  rounds, win/lose screens that actually work.
- Anti-frustration: never spawn enemies on top of the player; telegraph
  danger; first 30 seconds must teach the controls passively.
