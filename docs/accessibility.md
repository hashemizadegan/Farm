# Accessibility (target: WCAG 2.2 AA)

This describes what the code does to meet the target and how it is tested. It is not a conformance claim: run a manual audit with assistive technology before claiming conformance.

## Patterns used

| Need | Implementation |
| --- | --- |
| Keyboard operation (2.1.1) | Every task works without a pointer. Boundaries can be entered as coordinates or typed corners; the map is an optional aid. The 3D scene has a list view with standard buttons for every selectable element. |
| Semantic controls (1.3.1, 4.1.2) | Native `button`, `input`, `select`, `table` with `caption`/`th scope`; `TextField` wires `label`, hint and error via `aria-describedby` and `aria-invalid`. |
| Focus management (2.4.3, 2.4.7, 2.4.11) | Skip link; focus moves to `<main>` on client-side navigation; error summaries receive focus after a failed submit; visible 3 px focus outline. |
| Status messages (4.1.3) | `AnnouncerProvider` renders persistent polite/assertive live regions; used for saves, validation results, scene selection and quality changes. Boundary validation completion is announced while polling. |
| Reduced motion (2.3.3) | CSS `prefers-reduced-motion` disables transitions; the map uses `jumpTo` instead of `flyTo`; the 3D camera disables damping; the scene renders on demand (no continuous animation). |
| Text equivalents for map and 3D (1.1.1) | Boundary page lists every corner in a table and states area, provenance and validation status in text. The scene list gives each element's name, position and provenance. |
| WebGL fallback | WebGL is detected without throwing; failure, context loss or renderer errors switch to the list view with an explanation. `?view=list` forces it. |
| Colour (1.4.1, 1.4.3, 1.4.11) | Provenance and severity are always written as text. Token colours meet 4.5:1 (text) / 3:1 (UI) in light and dark schemes. |
| Target size (2.5.8) | Buttons and inputs are at least 44 px tall. |
| Dragging (2.5.7) | No task requires dragging: orbit/zoom in 3D and pan on the map have list/coordinate alternatives. |

## Tests

- `packages/ui/src/components.test.tsx`: label/description wiring, live region behaviour, text-based provenance.
- `tests/e2e/onboarding.spec.ts`: keyboard sign-in, error summary receives focus, axe-core scan with WCAG 2.0/2.1/2.2 A and AA tags (map canvas excluded because its content is mirrored in text on the same page).
- `tests/e2e/scene-and-security.spec.ts`: keyboard selection in the scene list, status announcement, WebGL-unavailable fallback.

## Manual checks before release

- Screen reader passes (NVDA + Firefox, VoiceOver + Safari, TalkBack + Chrome) through onboarding, boundary review, scenarios and the scene list.
- 200 % and 400 % zoom / 320 px reflow on every page.
- Windows High Contrast / forced colours.
