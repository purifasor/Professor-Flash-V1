# Skill — Performance Engineering (بهینه‌سازی — بازی و وب)

Every build must be FAST. A delivered project that runs at 1 FPS or freezes
the browser is a FAILED delivery. Apply these rules to every game, 3D scene,
and animation you emit — they are not optional.

## The golden rules of 60fps

1. **Zero per-frame allocations.** The game loop allocates NOTHING:
   - No `new Vector3()`, `new Array()`, object literals, string concat, or
     closures inside `update()/render()`. Preallocate ALL temp vectors/
     matrices/arrays once outside the loop and reuse them every frame.
   - `const _v = new THREE.Vector3()` module-level; per frame: `_v.set(...)`.
2. **Object pooling for everything transient.** Bullets, particles, damage
     numbers, tracers, corpses, decals: fixed-size pools created at init,
     `active` flag instead of add/remove, reuse dead slots. NEVER
     `scene.add()/remove()` per shot — that stalls the GC.
   - Particle system cap: ≤ 500 live particles; use ONE `BufferGeometry`
     `THREE.Points` with a `Float32Array` position buffer updated in-place
     (`needsUpdate = true`) instead of individual meshes.
3. **delta-time everywhere.** `const dt = Math.min((now - last) / 1000, 0.05)`.
   Physics/movement multiplied by dt. NEVER `position.x += speed` per frame.
   Fixed timestep (e.g. 60Hz accumulator) for physics, render interpolation.
4. **Renderer budget.**
   - `setPixelRatio(Math.min(devicePixelRatio, 1.5))` — 2x on retina phones
     is 4x the pixels for no visual gain; it's the #1 mobile FPS killer.
   - Shadows: ONE directional light with shadows max, `shadow.mapSize`
     1024 (2048 only on desktop scenes), tight shadow camera bounds.
     Many objects → `castShadow = false` except hero props.
   - Antialias true only if scene is simple; for particle-heavy scenes
     prefer `antialias: false` + slight resolution scale.
   - Fog culls far draw; set `camera.far` to what's actually visible.
   - Frustum culling is automatic — but merged static geometry beyond
     ~200 draw calls should use `InstancedMesh` (ground tiles, walls,
     trees, bullets in 2D-canvas equivalents).
5. **DOM and canvas in 2D games.**
   - HUD text: update only on change (score events), never per frame.
   - `ctx.fillText` is slow — cache rendered text/sprites on offscreen
     canvases once, `drawImage` per frame.
   - Avoid `ctx.shadowBlur` per frame (it re-renders the blur every call);
     pre-render glowing sprites to offscreen canvas instead.
   - `imageSmoothingEnabled` off for pixel-art; on for smooth games.
6. **Event listeners and loops.** One `requestAnimationFrame` loop total
   (never nested loops). Listeners registered ONCE at init, removed on
   pause (`cancelAnimationFrame`, removeEventListener on pause not needed
   if the loop stops). No `setInterval` for rendering — ever.
7. **Memory leaks that freeze tabs.**
   - `URL.createObjectURL`/audio buffers for repeated sounds → create once.
   - Never grow an array forever (trails, logs): ring buffer with cap.
   - Detach `onResize` handlers correctly; re-init on restart must not
     double-register listeners (guard with an `initialized` flag).
8. **The complexity budget.** Scene budget: ≤ 300 meshes, ≤ 500k
   triangles, ≤ 8 materials for the visible frame, lights ≤ 4 (1 shadow).
   If the design needs more: instancing, LOD (hide far objects), or
   simpler geometry. A beautiful 60fps beats a stunning slideshow.
9. **Start the loop ONLY when needed.** `document.hidden` → pause loop
   AND all `setInterval`s. Resume resets `lastTime` to avoid a giant dt
   jump on return.
10. **Test the number mentally before emitting:** every frame you should
    be able to answer "how many draw calls, how many new objects, how many
    pixel fills?" If any answer grows per frame or per shot, fix the
    design before writing code.

## Self-review pass (MANDATORY before finishing any build)

Before writing `SUMMARY:`, re-read your own code as a hostile reviewer and
fix what you find IN THE SAME EMISSION:

1. **Runtime correctness:** every function referenced is defined; every id
   the JS touches exists in the HTML; every event listener has its element.
   No truncated functions (the classic ReferenceError → blank page).
2. **Loop integrity:** one loop, dt clamped, no per-frame allocations,
   pools initialized before first use, listeners guarded against re-init.
3. **Restart resets EVERYTHING:** positions, velocities, health, score,
   timers, pools (all slots deactivated), UI state — a second playthrough
   is identical to the first.
4. **Console clean:** mentally execute the file top-to-bottom — zero
   ReferenceError/TypeError paths. Check script order: libraries (CDN)
   BEFORE the game script; `defer` or end-of-body placement.
5. **Fallbacks:** WebGL unsupported → visible message; pointer lock denied
   → still playable via keyboard look; localStorage blocked → in-memory.
6. **If ANY fix was needed during this review, emit the fixed file — the
   user must receive the version that passed review, not the draft.**

These rules apply to Python/backend work too: no O(n²) inside loops,
bounded caches, no unbounded queues, streaming instead of loading whole
files, indexes for lookups. Performance is part of correctness.
