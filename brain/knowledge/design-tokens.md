# Knowledge: Named Themes & Palettes (quick reference)

| Theme (fa)        | Theme (en)  | Primary   | Secondary | Accent    | Surface (dark) |
|-------------------|-------------|-----------|-----------|-----------|----------------|
| فیروزه‌ای         | Turquoise   | #40E0D0   | #0D9488   | #FF7F50   | #0B1220        |
| یاسی / بنفش       | Violet      | #8B5CF6   | #6D28D9   | #F59E0B   | #120E1F        |
| لجنی / سرمه‌ای    | Navy        | #3B82F6   | #1E40AF   | #F97316   | #0A0F1E        |
| زمردی             | Emerald     | #10B981   | #047857   | #FBBF24   | #07130E        |
| آتشی / قرمز       | Crimson     | #EF4444   | #991B1B   | #FCD34D   | #170B0B        |
| نئون قرمز         | Neon Red    | #FF3B30   | #A03530   | #FFD166   | #0A0908        |
| صورتی             | Rose        | #F472B6   | #BE185D   | #A5F3FC   | #160B12        |
| طلایی             | Gold        | #F59E0B   | #B45309   | #38BDF8   | #141005        |
| مینیمال           | Minimal     | #111827   | #6B7280   | #2563EB   | #0C0C0D        |

- Gradients: pick 2 stops from the same row; angle 135deg; never more than 2 hues.
- Glassmorphism: surface + 8-12% white overlay, blur 12-20px, 1px rgba(255,255,255,.08) border.
- Fonts: Persian UI → Vazirmatn; code/numbers → JetBrains Mono or system mono.

## Texture & material creation (for games/3D)
- Procedural canvas textures: layered value-noise for stone/ground; gradient
  + noise for metals; repeating patterns (bricks, tiles) drawn on a small
  canvas then `ctx.createPattern`.
- Material coherence: pick the theme palette, derive 4-6 shades per material
  (base, shadow, mid-light, highlight), keep roughness/rough-vs-glossy
  consistent per world.
- 3D: `MeshStandardMaterial` with `map` (canvas texture), consistent lighting
  (one key + one ambient + optional rim), fog matching the background color.
- 2D: pre-render sprites/frames to offscreen canvases; scale at draw time;
  keep pixel-art crisp with `imageSmoothingEnabled = false`.
