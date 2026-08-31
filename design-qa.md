# Lucky Scratch design QA

## Selected header — option 2

**Comparison target**

- Source visual truth: `/Users/qlement/.codex/generated_images/01a0100a-f202-7952-ac9a-53bfb259e20e/exec-acaf8089-f441-425f-9859-fd6f44938be1.png`
- Browser-rendered implementation: `/Users/qlement/Desktop/Lucky/qa-header-implementation-final.png`
- Final combined comparison: `/Users/qlement/Desktop/Lucky/qa-header-comparison-final.png`
- Full mobile view: `/Users/qlement/Desktop/Lucky/qa-mobile-final.png`
- Route: `http://127.0.0.1:3000/`
- State: signed-in demo player, 390-token balance, level 01, 100X Starter selected, all scratch cells covered.
- Verified viewports: 460 × 1000 and 360 × 900 CSS px.

**Final findings**

- No actionable P0, P1, or P2 mismatches remain.
- Hierarchy matches the selection: prismatic balance capsule at left, centered Lucky Scratch brand, orbit-framed profile/level group at right, connected progress line, oversized gold ticket value, and a wide faceted maximum-prize plaque.
- Proportions now follow the source closely. The balance panel occupies roughly one quarter of the header, the center brand has clear breathing room, and the level cluster remains visually dominant without crowding the label/value.
- The lower row preserves the reference's asymmetric balance: the ticket title is larger and left-weighted while the maximum-prize plaque anchors the right.
- Palette and material match the selected direction: near-black plum, violet crystal, cyan/magenta refraction, luminous gold, and restrained cyan progress.
- Dynamic copy and values remain live HTML. The generated raster assets contain no baked text, numbers, icons, or screenshots.
- The existing help action remains as a small low-emphasis control above the plaque. The profile avatar remains account-driven and sits inside the generated orbit ring.

**Comparison history**

- Pass 1: `/Users/qlement/Desktop/Lucky/qa-header-comparison-before.png`.
- Earlier P2 finding: the balance panel consumed too much horizontal space and the combined top/title stack was materially taller than the selected reference.
- Fix: changed the header to measured 112 px / flexible / 121 px columns, reduced the balance and orbit heights, tightened the progress/title spacing, reduced the ticket-title stack, and resized the prize plaque.
- Final pass: `/Users/qlement/Desktop/Lucky/qa-header-comparison-final.png`. The source and implementation are placed in the same image at equal width for direct visual inspection.

**Interaction and responsive QA**

- Balance capsule opens the top-up dialog.
- Level control opens the collection dialog.
- `更换` opens the ticket shop.
- Help opens the rules dialog.
- Profile still links to `/profile.html`.
- At 360 px there is no horizontal overflow (`scrollWidth === clientWidth === 360`).
- Browser console produced no warnings or errors during the interaction pass.

**Generated production assets**

- `public/prismatic-balance-panel.png` — transparent crystalline balance shell.
- `public/prismatic-level-orbit.png` — transparent circular level orbit.
- `public/lucky-clover-avatar.png` — transparent polished clover avatar used for the selected clover profile.
- `public/prismatic-max-plaque.png` — transparent faceted prize plaque.
- `public/gold-token.png` — transparent gold token.

## Previously selected scratch-grid block

- Source: `/Users/qlement/.codex/generated_images/01a0100a-f202-7952-ac9a-53bfb259e20e/exec-4332cf64-a755-4da7-b147-9fda1171cad1.png`.
- Final combined comparison: `/Users/qlement/Desktop/Lucky/qa-comparison-final.png`.
- The earlier scratch-grid implementation remains in place: prismatic winning tiles, generated foil canvas material, and generated swipe gesture, with all scratch behavior preserved.
- Its previous P2 tutorial-width mismatch was corrected and the final comparison passed.

## Selected collection and action block — option 3

**Comparison target**

- Source visual truth: `/Users/qlement/.codex/generated_images/01a0100a-f202-7952-ac9a-53bfb259e20e/exec-f359cff6-be55-40ad-8b49-bb60b04f89f0.png`
- Browser-rendered collection: `/Users/qlement/Desktop/Lucky/qa-option3-collection-final.jpg`
- Browser-rendered game actions: `/Users/qlement/Desktop/Lucky/qa-option3-game-actions.jpg`
- Combined focused comparison: `/Users/qlement/Desktop/Lucky/qa-option3-comparison.jpg`
- Route: `http://127.0.0.1:3000/`
- State: signed-in demo player, level 05, 100X Starter selected, one manager-configured ticket type in the local cloud configuration.
- Verified viewports: 390 × 844 and 320 × 800 CSS px.

**Final findings**

- No actionable P0, P1, or P2 mismatch remains in the collection or action regions.
- The collection now follows the selected album hierarchy: compact Lucky Scratch header, jewel-edged level plaque, a large centered crystalline collector card, and capsule pagination.
- The carousel is driven by the manager's current ticket types. The captured local state has one configured type; with additional types it exposes the neighboring locked/unlocked cards through horizontal scroll snapping and the pagination controls.
- The bottom game controls follow the selected layout: a restrained status row, two dark-violet secondary actions, and a full-width cyan ticket-shaped primary action.
- All labels, levels, balances, prices, unlock states, and best-win values remain live HTML. The generated raster assets contain no baked UI copy or screenshots.
- The 100X, locked, and generic unlocked card treatments use distinct production assets. Redeem and reveal use transparent generated action icons rather than text glyphs.
- The generated assets were resized for their measured slots while retaining alpha and more than 2× display density.

**Comparison and iteration history**

- Initial collection capture: `/Users/qlement/Desktop/Lucky/qa-option3-collection-before.png`.
- P2 finding: the compact bottom sheet did not match the selected immersive album height, and the first card was 16 px left of the sheet center.
- Fix: expanded only the collection sheet to 94dvh, increased the title scale, and corrected carousel edge padding so the active card and pagination align to the exact sheet center.
- Final pass: `/Users/qlement/Desktop/Lucky/qa-option3-comparison.jpg`. The source and both rendered implementation regions are placed in the same image for direct visual inspection.

**Interaction and responsive QA**

- The level control opens the new collection album and the close control returns focus correctly.
- Native horizontal scrolling, scroll snapping, and pagination buttons update the active collector card.
- `兑奖`, `全部刮开`, and `新的一张` preserve their original disabled states and game behavior.
- At 320 px there is no horizontal overflow (`scrollWidth === clientWidth === 320`).
- Browser console produced no errors during collection, reveal-all, result, and new-ticket interaction checks.

**Generated production assets**

- `public/collector-card-100x.png` — unlocked crown collector card.
- `public/collector-card-locked.png` — locked collector card.
- `public/collector-card-unlocked.png` — generic unlocked gem collector card.
- `public/collector-new-ticket-frame.png` — transparent full-width cyan ticket action.
- `public/action-redeem.png` and `public/action-reveal.png` — transparent secondary-action icons.

## Revealed scratch tiles — option 1

**Comparison target**

- Source visual truth: `/Users/qlement/.codex/generated_images/01a0100a-f202-7952-ac9a-53bfb259e20e/exec-ae4d8c70-610b-40d3-9cf6-caec4a2f909a.png` (853 × 1844 px).
- Browser-rendered implementation: `/Users/qlement/Desktop/Lucky/qa-revealed-option1-final.png` (390 × 844 px).
- Full-view equal-size comparison: `/Users/qlement/Desktop/Lucky/qa-revealed-option1-comparison-final.png`.
- Focused match comparison: `/Users/qlement/Desktop/Lucky/qa-revealed-option1-match-tiles-final.png`.
- Focused non-match comparison: `/Users/qlement/Desktop/Lucky/qa-revealed-option1-miss-tiles-final.png`.
- Narrow-phone capture: `/Users/qlement/Desktop/Lucky/qa-revealed-option1-320-top.png`.
- Route: `http://127.0.0.1:3000/`.
- State: signed-in demo player, forced `中1` ticket, 16 cells revealed, one genuine match, 15 non-matches, result poster dismissed.
- Normalization: source downsampled to the 390 × 844 CSS target; implementation captured at 390 × 844 px with device scale factor 1. Narrow QA used 320 × 800 CSS px.

**Final findings**

- No actionable P0, P1, or P2 mismatch remains.
- Fonts and typography: live system Chinese sans-serif remains consistent with the game; revealed numbers keep the source's heavy optical weight, prize copy stays clearly secondary, and the match ribbon remains legible at the smallest verified width.
- Spacing and layout rhythm: the original four-column grid, square proportions, measured gaps, radii, and vertical flow are unchanged. The new treatments fit inside the existing cells without shifting the winning panel or actions.
- Colors and visual tokens: non-matches use the selected pale lavender crystal with deep-purple text; genuine matches use the selected amethyst interior, warm-gold type and badge, violet inner rim, and restrained gold-magenta glow.
- Image quality and asset fidelity: both cell surfaces are 1024 × 1024 production rasters, and the 768 × 256 badge retains alpha. They downsample cleanly into the 66–88 px rendered slots with no stretching, placeholder art, or baked UI copy.
- Copy and content: number, prize, multiplier, and `匹配` remain live HTML backed by the real ticket state. Non-matches intentionally carry no extra status badge, matching the selected design.
- Accessibility: every revealed tile announces its number, total prize, and matched/not-matched state; covered keyboard behavior and canvas scratch behavior remain intact.

**Comparison and iteration history**

- Pass 1: `/Users/qlement/Desktop/Lucky/qa-revealed-option1-comparison-pass1.png`.
- Earlier P2 finding: the first non-match treatment rendered slightly brighter and less lavender than the selected frosted-crystal source.
- Fix: added a measured lavender blend to the generated non-match surface while preserving the source image's facets and white bevel.
- Final pass: `/Users/qlement/Desktop/Lucky/qa-revealed-option1-comparison-final.png`; focused match and non-match crops confirm the frame, badge, typography, prize hierarchy, and material treatment at equal scale.

**Interaction and responsive QA**

- Opened the built-in developer console, selected `中1`, issued a test card, revealed all cells, dismissed the result poster, and confirmed one `.is-match` plus 15 `.is-miss` cells.
- Match-only audio/vibration behavior and payout logic were not rewritten; the implementation changes only the render-state hook and visuals.
- At 320 px, `scrollWidth === clientWidth === 320`; the grid remains four columns and the tiles measure about 67 × 65 CSS px without clipping.
- Browser error log was empty after reveal, result dismissal, responsive resize, and screenshot capture.
- `npm run lint` and the complete 16-test build suite pass.

**Generated production assets**

- `public/revealed-tile-miss.png` — pale frosted-lavender non-match surface.
- `public/revealed-tile-match.png` — amethyst crystal match surface with gold/violet frame.
- `public/revealed-match-badge.png` — transparent gold match badge behind live `匹配` copy.

final result: passed
