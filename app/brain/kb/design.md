# UI/UX Design Principles
# keywords: طراحی, design, ui, ux, رابط, کاربر, زیبا, تم, theme, رنگ, رنگ‌ها, فاصله, تایپوگرافی, دارک

Design principles for the sites and apps Professor Flash builds.

## Layout & spacing
- Consistent spacing scale (4px base: 4/8/12/16/24/32/48).
- Align elements on a grid; generous padding inside cards.
- Max content width ~1100px, centered, with side padding on mobile.

## Color
- Dark theme: dark background (#0b0f17 range), elevated panels one step
  lighter, one accent color (used sparingly: buttons, links, highlights),
  muted text for secondary content.
- Contrast: body text >= 7:1 on background; never pure white on pure black
  (use #e6e9f0 on #0b0f17).
- A single accent creates identity; 2 accents max.

## Typography
- One or two font families max. Persian UI: Vazirmatn.
- Hierarchy: large bold headings, regular body, smaller muted labels.
- Line-height 1.7-1.9 for Persian text; not too narrow.

## Components
- Buttons: clear hover/active states, focus outline for keyboard users.
- Cards: subtle border + soft shadow; hover raises slightly.
- Forms: labels above inputs, clear placeholder, visible focus ring.

## Motion
- Subtle, purposeful animation (entrance fade, hover lift).
- Respect `prefers-reduced-motion`.
- Never animate layout-affecting properties (top/left/width) - use
  transform/opacity.

## Accessibility
- Buttons have `aria-label` when icon-only; images have `alt`.
- Keyboard navigable; visible focus; touch targets >= 40px.

## Header
- A good header: brand/logo on one side, nav in the middle/other side,
  a call-to-action button, sticky with a translucent blur background.
