# VideoAutoCut HyperFrames Constraints

## Scope

Generate one self-contained HTML/CSS/JavaScript motion graphic for a single video shot.
This skill is used by VideoAutoCut when dynamic HyperFrames code generation is enabled.
These constraints are loaded after selected official HyperFrames skills and references.

## Required Contract

- Produce an `index.html` compatible with the local HyperFrames CLI.
- Include one root composition with fixed 1920x1080 dimensions.
- Use clip elements with stable `data-start`, `data-duration`, and `data-track-index` attributes when the renderer needs timeline metadata.
- Use GSAP if animation scripting is needed. Prefer local `./gsap.min.js` when enough, but HTTPS CDN scripts are allowed for richer effects.
- HTTPS static resources are allowed during rendering, including CDN scripts, fonts, images, SVGs, videos, and CSS.
- Output only JSON with a `source` field when asked to generate or repair code.

## Allowed Runtime

- HTML
- CSS
- Plain JavaScript
- Local or HTTPS-loaded animation libraries

## Forbidden

- Active network request logic such as `fetch`, `XMLHttpRequest`, `WebSocket`, or `EventSource`.
- Arbitrary filesystem access.
- Browser APIs that require user interaction.
- Non-deterministic animations that cannot be rendered frame by frame.

## Visual Rules

- Suitable for motion graphics, data dashboards, process flows, infographic cards, timelines, and brand-style abstract scenes.
- Keep all important elements inside the 1920x1080 safe area.
- Avoid heavy DOM trees and excessive filters.
- Do not display raw JSON field names or internal implementation details.
- Keep one stable layout system for the whole composition. Do not switch between unrelated page layouts.
- Each scene must have exactly one dominant visual focus. Supporting elements must stay muted or secondary.
- Keep each scene to 7 or fewer foreground content elements. Use labels shorter than 18 characters where possible.
- Never dump all nodes, all modules, all captions, and the timeline onto the canvas at the same time.
- Use progressive reveal and focus shifts: dim old elements, highlight the current scene, and move flow lines only where attention should go.
- Prefer structured zones such as header, main diagram, side callout, bottom timeline, and status strip over free-floating cards.
- Text must not overlap. Long labels must be shortened, wrapped, or replaced by icons/abbreviations.

## Failure Repair Rules

- If lint fails, simplify the DOM and timeline.
- If render fails because a browser feature is unsupported, replace it with basic HTML/CSS/GSAP animation.
- If animation timing is invalid, normalize all clip starts and durations to the shot duration.
