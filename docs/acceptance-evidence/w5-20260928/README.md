# W5 acceptance evidence — 2026-09-28

Status: **BLOCKED**. These four PNGs are evidence for the stopped W5 review. They do not accept W5 or authorize UI/E2E/W6.

- Source and render HEAD: `3715aa42c0b71894dd62e0df28900b380aa5a43a`
- Contract: `docs/fix-round-acceptance-2026-09-23.md:505-519`
- Capture: original frame at 2.5 seconds from each isolated W5 MP4
- Mac reference PNGs were unavailable on the render machine; these frames are for Mac side-by-side review.

## Blocking findings

1. Instruction 51384843 forbids Qwen calls during W5. The 5a shot 6 run actually called the packaging agent once through provider `evst-gateway` with `pi_model=qwen3.6-plus`; `model_seconds=2.479`. Historical W2/W3 material-import usage remains 9 calls. No remaining Qwen call is claimed available; U7 is frozen pending Mac/user direction.
2. The 5b shot 6 contract requires one page with two visual lines. The rendered frame and `template.json` contain four visual lines: `缓存 → 上下料 → 在线` / `检测` / `对接：AGV · AMR ·` / `皮带机 · 理料机`.

## Input provenance

W5 used the authorized A1 cue sidecars copied byte-for-byte into the four isolated input directories:

- Shot 1 cue SHA-256: `b38c39afe98f3289777d1b2c21a15c55b23b15a77503a5495728529b672a48fa`
- Shot 6 cue SHA-256: `f1da517990e3198146e21b48e67d37f727bee4026ed819dd422a2ece66f72bf6`
- Frozen W3 plan SHA-256: `b9714bfc0bbb327e28bb51a01f1c63512085abd231ea85316f7488d089629fc7`

This W5 run only tests packaging and rendering on the frozen W3 plan with A1 sidecars. It does not prove cue generation.

## Files

| File | SHA-256 |
|---|---|
| `agent-s1-shot1-2.5s.png` | `384c61353bf37df0f088632167eb853158bdb5ae70b94f3678eaf263c7aeaad1` |
| `agent-s6-shot6-2.5s.png` | `cae25c4f08a9c05ba287571dbc97629e8f81150d4cd27813b046201a73e023f1` |
| `deterministic-s1-shot1-2.5s.png` | `384c61353bf37df0f088632167eb853158bdb5ae70b94f3678eaf263c7aeaad1` |
| `deterministic-s6-shot6-2.5s.png` | `cae25c4f08a9c05ba287571dbc97629e8f81150d4cd27813b046201a73e023f1` |

The same-shot agent and deterministic MP4s produced byte-identical evidence frames. No auth data, environment dump, complete runtime log, or MP4 is included here.
