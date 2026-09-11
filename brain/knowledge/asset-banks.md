# Knowledge: Procedural Asset Banks (texture / model / animation / FX library)

The agent has NO internet asset downloads in the sandbox — every texture,
model, and animation is generated procedurally. This bank is the standard
recipe set. Use it instead of fetching assets; the output must look
deliberate, not programmer-art.

## Texture bank (canvas-generated, palette-locked)
- **valueNoise(x, y, seed):** hash-based smooth noise; 2–4 octaves with
  lacunarity 2, gain 0.5 → organic base for stone, ground, rust, wood.
- **Concrete/asphalt:** noise base + sparse dark speckles + 2–3 crack paths
  (random walk with jitter). RepeatWrapping, roughness 0.9.
- **Brick/tile:** grid mortar lines (1–2px dark) + per-cell hue jitter ±5% +
  noise overlay. Offset alternate rows.
- **Metal/panel:** brushed lines (1px alpha streaks) + rivet dots at
  corners + subtle gradient + edge wear (lighter 1px border on top edge).
- **Wood:** horizontal stretched noise + darker rings (sin of scaled y) +
  fine grain streaks.
- **Neon/emissive:** pure-color fill + inner glow (shadowBlur trick onto
  offscreen canvas ONCE, then drawImage per frame — never shadowBlur in
  the render loop).
- **Skin/creature:** base tone + noise pores + blush gradient zones; NEVER
  flat single-color characters.
- **Sky:** vertical gradient (3–5 stops from the palette) + optional
  procedural clouds (noise thresholded, soft alpha) — matched to `scene.fog`
  color exactly to avoid voids.
- Resolution: 256–512 canvas textures are plenty; generate at 2× and
  downscale for crispness. `texture.colorSpace = THREE.SRGBColorSpace`.

## Model bank (Three.js primitives composed with intent)
- **Characters:** root group → torso (capsule/box) → head (sphere/box) +
  eyes (small spheres, dark + specular) + limbs (capsules) parented at
  joints. Identity via 2–3 signature props (helmet crest, backpack, tail,
  glow rings). Never a lone naked sphere — always eyes/limbs/accessory.
- **Vehicles/props:** compose 4–10 primitives into a silhouette that reads
  instantly (car = low slab + cabin + 4 cylinder wheels + headlight discs).
  Add a ground-contact shadow blob (dark transparent circle) under every
  hovering/floating prop.
- **Environment:** buildings from box arrays with window grids (emissive
  plane strips), trees from cylinder trunk + 2–3 noise-textured cones or
  billboards, rocks from deformed icosahedrons (vertex displacement with
  seeded random), fences from instanced planks.
- **InstancedMesh rule:** the same object appearing >20 times (grass,
  bullets, crowd, forest) = ONE InstancedMesh, per-instance matrix updates.
- **Human scale:** door 2.1m, ceiling 2.8–3.5m, hero room 8–20m. A scene
  must feel sized, not arbitrary.

## Animation bank (procedural motion recipes)
- **Idle:** breathing `scale.y = 1 + 0.02*sin(t*2)`; sway
  `rotation.z = 0.03*sin(t*0.7+phase)`.
- **Walk/run:** limb swing `rotation.x = swing*sin(t*speed)` alternate
  phase π; body bob `position.y += 0.05*|sin(t*speed)|`; forward lean
  proportional to speed.
- **Flap/fly:** wing `rotation.z = 0.6*sin(t*8)` with body tilt into
  direction; feather trail particles optional.
- **Jump:** anticipation squash (0.9 scale, 80ms) → launch stretch (1.1) →
  apex neutral → land squash + settle spring.
- **Attack/melee:** wind-up (rotate back, 120ms ease-out) → snap forward
  (60ms ease-in) → follow-through overshoot + settle (200ms).
- **Death:** ragdoll-ish tumble (random angular velocity decaying) + sink
  0.2m + fade material opacity → pool slot release.
- **UI motion:** 200–350ms cubic-bezier(.16,1,.3,1); never linear, never
  >400ms; hovers 120–180ms.
- **Clock discipline:** ALL animations read the same `elapsed` accumulator
  (scaled by a timeScale for slow-mo effects) — one clock, zero drift.

## FX bank (damage / death / victory / defeat / shooting)
- **Damage:** emissive flash (`material.emissive` pulse 80ms), pooled
  damage numbers (DOM sprites: pop-scale 1.4→1, rise 40px, fade 600ms),
  directional particle burst (6–12 pooled quads), hit-stop 40ms on heavy
  hits, camera shake `amp * exp(-t*8) * noise`.
- **Blood:** pooled particle quads with gravity, red palette variance,
  small decals (fading dark circles on ground for 10s, ring buffer of 24).
  Tone-match the art style: stylized crimson for cartoon, dark spray for
  realistic.
- **Shooting:** muzzle flash (1-frame bright quad + point-light pulse),
  tracer (thin stretched quad fading 60ms along travel), shell casing
  (pooled small box with spin + gravity + bounce sound feel), impact
  sparks + decal, recoil (camera pitch kick 0.5–2° spring-back), ADS FOV
  lerp 75→45 over 180ms.
- **Victory:** timeScale 0.2 for 0.5s (slow-mo) → confetti burst (pooled
  colored quads, 60–100 count) + gold screen flash + score count-up +
  triumphant WebAudio arpeggio.
- **Defeat:** desaturate overlay (CSS filter on canvas container), red
  vignette pulse, low drone (WebAudio oscillator 80Hz decay), screen
  shake, then defeat panel with clean restart.
- **Respawn/revive:** iris-in circle wipe, invulnerability blink
  (opacity 4Hz for 1.5s), spawn ring particles.
- **WebAudio recipes (zero files):** shoot = noise burst 30ms + 200Hz thump;
  hit = 150Hz click; death = descending saw 300→60Hz over 300ms; win =
  triad arpeggio (C-E-G, square, 90ms steps); UI = 800Hz blip 20ms.
  Create AudioContext lazily on first user gesture only.

## Cinematography
- **Win/lose are events:** camera dolly-in 1.2m on victory, slight orbit
  slow-mo; on defeat the camera drifts up and away from the body.
- **Vignette layers:** permanent subtle vignette (radial-gradient CSS) +
  dynamic red pulse on damage (opacity keyframed) — DOM overlays, zero
  WebGL cost.
- **Letterbox cutscene bars** (2 divs sliding in) for win/lose sequences.
