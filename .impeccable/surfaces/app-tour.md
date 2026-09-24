# Zentra — visual app visit

Mode: Experience, extending the approved Studio / Apple world. The user explicitly replaces the form-based invoice demo with real app images covering its menus, a fictional demonstration company and short explanations. This overrides preserving the old input form on this route. No new visual-world round; code-led continuation.

THESIS: Enter the product without setup. Pick a familiar task, see its actual screen, understand one useful action.
OWN-WORLD: Incumbent Geist, forest green, white and pearl, flat controls and fine separators. Real screenshots from the current Gestion React UI supply the visual content; no generated facsimiles.
STORY: Atelier du Léman, a fictional company, provides clients, projects, documents and team records. The visitor moves through the main modules, switches between desktop and phone, and can inspect an enlarged capture. Automation is explicitly an option; e-mail paths require linked Support.
FIRST VIEWPORT: A short invitation, a restrained module selector and the first real screenshot. No fields to complete, no account needed, no long instructions. Phone gets phone captures and one compact menu selector.
FORM: Precisely requested image tour in existing Studio identity. Reuse /demo-facture to preserve incoming links; update surrounding copy so it no longer promises invoice editing or PDF export.
MOTION: Only the selected screenshot/caption settles into place, short ease-out, disabled under reduced motion. No auto-playing slideshow.
FINISH: Independent finish review, then documenter; local source captures, asset provenance and browser evidence retained. Product screenshots are real UI with synthetic data, not proof of native installation, cloud writes or financial calculations.

## Implemented extension — 24 September 2026

The retained `/demo-facture` route now renders `AppTour`. Its source of content is `lib/app-tour.ts`: 18 modules grouped into Votre quotidien, Votre activité and Votre entreprise. Each module has one real desktop capture and one real phone capture, a short explanation and an optional detail. `docs/APP-TOUR-ASSETS.md` records the source application version, fictional fixture and image provenance. The page ends with the existing download and pricing destinations.

This is an ordinary extension of Zentra Studio. `PRODUCT.md`, the token-bearing `DESIGN.md` and `.impeccable/design.json` remain the system authorities; this brief records the tour's local implementation without promoting its dimensions, overlays or image behavior into global tokens.

### Relationship to the incumbent system

- The page inherits the Studio Geist stack. Forest green, paper, pearl, ink, muted text and thin rules come from the existing `--studio-*` variables. The header, footer and final actions retain their shared components and classes.
- Open composition keeps the actual application screen as the visual content. A fine frame contains that screen; descriptions and pagination remain open, separated by space and a rule. The fictional-company label appears beside the format selector and the image caption identifies demonstration data.
- The mobile and tablet thresholds remain the established 760px and 1100px. The navigation changes to a labelled native select on mobile, with a phone image by default. The visitor can explicitly override the image format at any width.
- Selection uses forest text on a tinted menu row and a white segment on a pearl format control. These continue the incumbent selection language. Focus uses a local 3px forest outline with a 4px offset.

### Intentional local dimensions and treatments

| Role | Implemented local variant | Purpose |
| --- | --- | --- |
| Invitation | `clamp(38px, 5vw, 64px)`, weight 540, line height 1.1; 38px on mobile | Leaves room for the first real screen while retaining Studio's title rhythm. |
| Introductory copy | 18px / 1.7, then 16px on mobile | A short invitation before the image. |
| Tour layout | Maximum 1440px; 210px index and 32px gap; at 1100px, 185px index and 24px gap | Gives the product screenshot priority over navigation. |
| Mobile layout | Single column with 16px outer gutters; phone capture capped at 340px | Fits the source phone image without an invented device shell. |
| Explanation | Maximum 740px; title 28px, 25px at tablet, 26px on mobile; copy 17px then 16px | Keeps the explanation readable beneath a much wider desktop image. |
| Controls | Menu rows have a 42px minimum; format buttons 36px then 40px at the tablet threshold; phone select 48px; pagination, detail and close controls 44px | Documents the actual local control sizes; these do not redefine the shared button minimum. |
| Frame and overlay | Image frame 14px, then 12px on mobile; enlargement label 8px; dialog 14px | Reuses the restrained corner language with one compact image-overlay variant. |
| Depth | Selected format `0 2px 5px #19251f0a`; enlargement label `0 4px 15px #0002`; dialog backdrop `#101b14c9` | Separates selected format and inspection controls from screenshot content; these are local alpha treatments. |
| Inspection | Dialog capped at 1480px; desktop image keeps a 1000px minimum within its scroll area; phone dialog capped at 470px | Enables close reading of the real capture while keeping the surrounding page responsive. |
| Image arrival | 220ms with `cubic-bezier(.16,1,.3,1)`, opacity 0.7 to 1 and blur 1.5px to 0 | Reuses Studio's easing with a shorter, image-only reveal; no autoplay. |

### Interaction and content contract

The desktop menu and phone selector address the same ordered list. Selection updates the URL hash; direct hashes choose a module and unknown hashes fall back to the first screen. Previous and Next stop at the ends. The format buttons expose their selected state and keep an explicit choice across module changes. Only the selected screen is mounted; the full image collection is not eagerly rendered.

The image is a labelled button that opens a native modal dialog with a labelled close action. The supplied browser evidence covers Escape and focus restoration. A failed image exposes a text alert and Réessayer. The explanation is a polite live region; its optional detail resets when the module changes. Reduced motion removes the image animation and makes pagination scrolling immediate.

Copy retains the distinction between Gestion, optional Automation and linked Support. Payroll, banking and accounting details retain their stated limits. The photographed interface is an illustration with synthetic data; its internal controls are not an editable public application. Changes to the real application should trigger a source/provenance check before its screenshots or accompanying claims are refreshed.

### Completion evidence and inherited drift

The independent review in `.impeccable/review/app-tour/finish-review.md` has disposition `ship` and all five contract sections: persistence, fidelity, ceiling, material_fixes and keep. It reports no material fixes at the supplied scope. `browser-report.json` records 74 passing checks, no page errors and no page overflow for Edge at 1440px/390px and WebKit at 320px. `verification.md` records 36 passing focused tests, TypeScript, changed-file lint and whitespace checks. The documentation pass inspected those existing records and final sources; it did not open a browser, rerun tests or add a new visual verdict.

Existing Studio documentation already identifies residual amber download styling, Support eyebrows and explicit system-font inheritance. They remain inherited exceptions, not patterns adopted by this tour; this pass did not investigate or repair them. The current context loader also reports null target bindings for the existing surface briefs, including this one, so it cannot select this brief unambiguously by route. That pre-existing metadata drift is reported only; the explicit file supplied in the handoff was used.

The documented result establishes the local visual visit and supplied interaction checks. Publication, native installation, financial correctness, live synchronization and connected-service execution require their own evidence.
