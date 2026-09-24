# Automation arrival and workspace refinement — 2026-09-25

Mode: Experience for the finite welcome; Operate for daily screens.

## Direction and focal moment

Reuse the approved Zentra light/wordmark introduction when Automation becomes available, and refine the app's menus and screens within the existing Apple-like, light, readable world. This extends the established system. The signature “Place à ce qui compte.”, orbital filaments, the real Zentra wordmark and the Automation title form the focal moment.

The shared ZentraArrival sequence lasts 7.8 seconds. “Passer l’introduction” reaches the final composition immediately; the close control remains available. The existing deep green stage, luminous canvas and pill-shaped actions are a finite, scoped exception inherited from the approved onboarding. They are not a new palette, shape system or persistent effect for daily screens. The canvas stops drawing at rest and pauses while the document is hidden. Reduced motion goes directly to the static final composition and omits the animation replay control there.

## Access and timing

- Automatic presentation requires a non-empty selected organization, a `ready` company snapshot, the same organization in its response, and `state.active`. Loading, missing, stale, mismatched and inactive access do not qualify.
- Automatic presentation is limited to Tableau de bord and Automation. A one-second idle check defers it while the document is hidden, another dialogue exists, an element is busy, or an input, textarea, select or editable region holds focus.
- The welcome disappears when confirmed access is lost. The component is keyed by organization, so changing companies disposes of the previous company's presentation.
- The seen preference is scoped by organization in local storage on this app/device: `zentra.automation.welcome.v1:<encoded organization id>`. Finishing or skipping the sequence, starting, or closing records it. Closing also records an in-memory fallback when storage is unavailable. Clearing the app's local storage or using another device can permit a new presentation.
- “Revoir l’introduction” in Automation settings explicitly requests a replay for the selected company. It still requires confirmed access and a quiet moment; the view restriction and seen flag do not block that deliberate request.

## Next action and product boundary

A manager with writable access who still lacks consent, an enabled configuration or selected functions sees “Configurer Automation”. It closes the welcome, then opens existing Automation settings. Other users see “Découvrir Automation”, which opens the full activity destination. Navigation waits for the dialogue to unmount so existing navigation guards remain effective.

The welcome is a presentation preference. It does not purchase, enable or grant Automation, submit consent, change business settings, or create business data. An active entitlement is not a claim that configured automation is running. Company permissions and all existing business routes remain authoritative; configuration and consent stay separate user actions. Full activity remains Automation's default destination.

## Daily continuity and mobile

Shared work surfaces use a slightly lighter canvas and distinct rail, quieter tonal menu selection, a deeper dark palette, 11px control corners, a 64px minimum topbar and one short screen arrival (220ms, 4px, opacity .72 to 1). Buttons, segments, fields, tables, empty states and settings use the shared refinements recorded in DESIGN.md. Ordinary menu changes do not replay the brand sequence.

Automation switches use the same 42×26px track, 20px thumb, accent state and visible focus in both the Automation hub and general settings. Extending the existing style to both entry points preserves checked, disabled and permission-controlled behavior; it changes presentation only.

Phone fields remain at least 48px high with 16px text; settings rows are at least 72px. Actions can wrap while retaining their labels. Native safe-area variables take precedence over browser env() fallbacks. The welcome retains a 44px close target, 48px skip/replay targets and a 56px primary action. Narrow and short landscape compositions adjust the logo/title placement; the explanatory subtitle is omitted only in the very short wide layout. Dialogue focus handling and visible keyboard focus remain in place. French, German, Italian and English are preserved.

## Assets and evidence

The logo is the existing `src/assets/zentra-wordmark.png`, shared by BrandWordmark and the canvas sampling code. Motion is authored in code; no new image, remote media, sound or animation dependency is introduced.

The local Edge and WebKit activation journeys use actual shared React surfaces with synthetic company data. Their current reports cover sequence, skip/replay, once-only behavior and reachable controls at 1440, 390, 320 and 844px landscape, plus active access, dialogue deferral, revocation, company isolation, reduced motion, four languages and unchanged consent. Reports: `.qa/automation-arrival/welcome-edge.json` and `welcome-webkit.json`.

The TypeScript/Vite build (`pnpm build:web`) and the rerun of 33 targeted unit tests pass. The shared-screen reports contain 224 navigation/render visits: Edge has six configurations with 32 states each, and WebKit has one with 32 states. They record no JavaScript page errors or document-level horizontal overflow. Final screenshots use loaded screen content, including the read-only ledger fixture; supplier preparation remains deliberately disabled in the visual fixture to avoid accounting writes. This evidence is about navigation and rendering, not every business operation. The original onboarding motion report also passes. Dark-field text/focus and the light canvas return were checked.

The [independent visual review](../review/automation-activation/review.md) concludes **ship** for the examined frontend change, with no new material defect and no code fix requested. It inspected seven contact sheets, all ten welcome captures individually and sixteen work-screen captures at full resolution, with three approved onboarding frames as references. The 224 visits were not all reviewed individually at full resolution, and viewport captures do not cover every scrolled area. Final captures are in `.impeccable/review/automation-activation`.

Inherited untranslated business text and the narrow 320px wrapping of “Einstellungen” remain; the new welcome copy is present in all four languages. The verdict does not certify exhaustive accessibility, complete app translation or every business flow. Browser/synthetic evidence does not establish a native Windows, macOS, iOS or Android installation, mobile performance, production behavior, store release or publication. See the scoped change report at `../../../docs/APP-AUTOMATION-ARRIVAL-20260925.md`.
