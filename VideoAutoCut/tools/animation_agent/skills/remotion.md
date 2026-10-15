# VideoAutoCut Remotion Constraints

## Scope

Generate one self-contained Remotion/React animation component for a single video shot.
This skill is used by VideoAutoCut when dynamic Remotion code generation is enabled.
It is loaded after the official Remotion `llms.txt`, official Remotion `SKILL.md`,
and any selected official Remotion rule files.

## Required Contract

- Export `AiGeneratedMaterialVideo` from a plain `.jsx` file.
- Accept all shot data through props or an injected JSON plan. Do not read arbitrary files.
- Use Remotion frame APIs such as `useCurrentFrame`, `useVideoConfig`, `interpolate`, and `spring`.
- Keep the composition deterministic and suitable for 1920x1080 output.
- Output only JSON with a `source` field when asked to generate or repair code.

## Allowed Runtime

- React
- Remotion
- Plain JavaScript and JSX. Do not use TypeScript-only syntax, type annotations, interfaces, or enums.
- Local CSS-in-JS or inline styles

## Forbidden

- Network requests.
- Shell commands.
- Arbitrary filesystem access.
- Browser APIs that depend on user interaction.
- External image/video/font dependencies unless VideoAutoCut explicitly passes them as local asset paths.

## Visual Rules

- Suitable for title cards, UI cards, caption packaging, metric cards, timelines, comparisons, and graphic overlays.
- Use restrained motion and predictable layout.
- Keep text readable. Avoid viewport-scaled font sizes that can overflow.
- Do not display raw JSON field names or internal implementation details.

## Failure Repair Rules

- TypeScript or bundling errors must be fixed by simplifying imports and using stable Remotion APIs.
- If rendering fails because of missing assets, remove the asset dependency or replace it with generated shapes.
- If layout overflows, reduce text length, split lines, or simplify the component.
