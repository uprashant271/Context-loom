# Context Loom — design reference

System: parchment, warm copper and olive-charcoal, Redesign / Preserve. The palette replaces cobalt and white following explicit user feedback.

Existing identity assets: the original ≋ wordmark in index.html and the palette-matched embedded SVG favicon in index.html/guide.html. The source-to-memory hero uses real excerpts from fixtures.json and claude-results.json, correction / hybrid; it is explicitly recorded synthetic evidence. No invented product imagery or outcomes.

Font assets: dist/assets/fonts/space-grotesk-variable.ttf; ibm-plex-mono-regular.ttf; ibm-plex-mono-medium.ttf. Both SIL Open Font License texts are colocated. Sources are the official google/fonts repository.

Palette: copper #84543D; olive-charcoal ink #292C25; parchment #EEE7D9; oatmeal surface #F6F0E5; sage preservation #E0E5D6; amber selection #B47D46 with #F0E2CF tint; neutral rules #D4D1C4. Inverse surfaces use #242922 with cream #F1EDE3 text.

Type: Space Grotesk headings/body; IBM Plex Mono code/trace metadata. Spacing 8/16/24/32/48/64/96px. Radius controls8px, grouped surfaces16px. Flat data surfaces and one restrained hero shadow.

Current scope: warm palette plus interaction polish across hero, lab, guide, controls, evidence states and code panels. Selection and omission have explicit text labels. Recorded data, model/backend behavior and routes are preserved.


Motion reference: user-requested MengTo/Skills, specifically agent-skills/web-design/animation-on-scroll and agent-skills/codex/optimize-web-animations. Adapted to the existing identity and self-only CSP, using native IntersectionObserver and Web Animations; no animation library, scroll interception, blur filters or perpetual decorative loops.

Interaction rhythm: 100ms transform-only threshold feedback; 160-180ms hover/press/chevron feedback; 200ms lab pane changes; 220ms disclosure content entry; 420ms one-time section entrances with 10px travel and at most 45ms per-step stagger. Easing is cubic-bezier(.22,1,.36,1). Every trace selection commits immediately; previous pane animations are cancelled. Source scroll remains on same-session changes, and resets for a new session. Copy status resets after 2400ms and has a stable button width.

Resource contract: content remains visible with motion unavailable; only visible targets animate. Offscreen targets cancel, hidden pages disconnect observers, and reduced-motion preferences cancel motion. The only repeating animation is the real local-request busy indicator, paused offscreen/hidden and removed at completion. Page exit aborts browser fetches, clears the copy timer, and cancels animations; bfcache restoration restores resource ownership. Aborting a browser request does not claim to cancel work already executing on the server. Edited session JSON survives trace changes and can be replaced explicitly with Load selected example.

Accessibility: skip link, clear focus outlines, keyboard-accessible source/memory regions, 44px control targets, native details disclosures, polite copy/local-result feedback, table column headers and reduced-motion fallback. Desktop/mobile browser observations and focused lifecycle regressions are documented in interaction-checks.md.
