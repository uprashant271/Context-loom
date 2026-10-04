# Interaction verification — 2026-10-04

Reference: [MengTo/Skills](https://github.com/MengTo/Skills), animation-on-scroll and optimize-web-animations. The approved parchment/copper/olive palette is retained.

## Browser observations

The existing Codex in-app localhost preview was reloaded after changes. Desktop viewport: 1195 × 853; responsive check: 390 × 844, restored afterward.

- Rapid selection changes ended on the latest requested method with the matching recorded memory and status.
- A recorded WebMCP replay displayed pending/hybrid/Claude immediately and returned the matching state.
- Keyboard threshold adjustment updated 70% to 71%; the meter interpolated with scaleX, without changing its width.
- Native protocol disclosure opened with its existing content and keyboard semantics.
- Copy commands showed “Copied ✓” and a polite announcement, then returned to “Copy commands” with an empty announcement.
- Source regions accepted PageDown and exposed tabindex=0. Changing sessions reset source scroll to zero.
- Three repeated correction/hybrid replays left 312 DOM elements and six source messages; no accumulating message nodes were observed.
- The 28-message irrelevant-noise trace remained scrollable on mobile. Neither the top nor the lab had horizontal overflow.
- Browser warning/error logs were empty for the completed interaction pass.

## Motion observations

Baseline computed CSS animation counts were zero at desktop top/middle/footer. After changes, settled desktop lab/footer and mobile top/lab samples also showed zero running CSS animations, zero offscreen running CSS animations, and zero canvases. Settled desktop/mobile lab DOM markers showed zero active Web Animation targets and zero offscreen active targets. During rapid interaction, active target markers were present and subsequently cleared.

The browser's read-only inspection surface did not expose document.getAnimations(), so Web Animations were inspected through their DOM-backed active markers and lifecycle tests. These observations establish bounded idle activity; they are not a measured FPS, GPU, or heap-leak result. Source inspection found no app-owned requestAnimationFrame loop. The real local-inference busy indicator is the only repeating CSS animation and is visibility/reduced-motion gated.

## Regression verification

Run from the extracted project directory:

```sh
node --test tests/test_site.mjs
```

All 21 tests passed. The Node VM harness checks input preservation, explicit example replacement, source/memory scroll behavior, concurrent data loading, missing results, copy races/reset, invalid input before inference, duplicate submission prevention, structured HTTP errors, abort/stale responses, bfcache restoration, WebMCP validation/state, transform-only meter updates, rapid animation cancellation, reduced motion, hidden/offscreen targets, once-only reveals, focus/disclosures, and request-only spinner visibility.

The harness substitutes DOM, requests and animation primitives. Browser layout and visual observations complement it; no real inference or model quality measurement was rerun for this interaction change. Existing benchmark JSON files were unchanged. JavaScript syntax checks and Git whitespace checks passed.
