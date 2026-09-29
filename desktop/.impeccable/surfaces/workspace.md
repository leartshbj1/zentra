# Zentra — complete workspace redesign

Mode: Operate. User-pinned Apple application, code-led as previously requested. Replace the accumulated card-heavy presentation across the shared application; preserve business logic, Automation entitlements and full activity, offline and collaboration flows, and printed documents.

## Direction contract
THESIS: One working window, readable records and controls that stay out of the way. Financial information appears before a compact Automation briefing; the Automation destination retains the complete journal first.

OWN-WORLD: White navigation and paper surfaces on a pearl-gray working canvas, system text, charcoal ink, fine separators and forest-green actions. Dark mode uses distinct graphite levels with a pale green active destination. Corners distinguish controls and working sheets.

STORY: Recognize the company, find a module, read its records, act. Secondary explanations open on demand. No invented statistics or savings.

FIRST VIEWPORT: A 244px desktop navigation rail, 72px toolbar, a 38px page title and a single primary action. Four financial columns lead the dashboard; Automation and follow-up share the next row. Mobile: 64px safe-area toolbar, 32px title, full-width records, bottom navigation; no desktop columns squeezed into a phone.

FORM: Precision instrument, candidate 3, seed 56c39c55, translated into the user's pinned Apple simplicity. The selected direction is precision calme. Candidates and challenger verdicts are recorded in docs/DESIGN-REFONTE-186.md. No generated comp: the user chose an interactive code-led preview.

MOTION: The page arrives with a short 8px settle; selection responds immediately. Drawers keep continuous finger tracking. No staggered data, looping decoration or motion when reduced motion is requested.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## References
- https://www.apple.com/os/macos/ — shared toolbar and sidebar conventions, content legibility.
- https://culturedcode.com/things/ — grouped lists and progressive detail.
- https://linear.app/now/behind-the-latest-design-refresh — reduced visual competition and coherent navigation.

## Verification boundary
Inspect dashboard, all modules, forms and settings on desktop1440, phone390, narrow320, both themes and long translated copy. Test real frontend paths using synthetic fixtures. Build actual platform binaries and verify releases independently of the browser preview.

## Accounting enlarged-text reflow — 29 September 2026

The subsequent accounting navigation refinement combines all eleven destinations in the compact picker and removes the redundant tools picker on phones. The selected title uses the full flex column after its icon is hidden. A wrapping period caption overlays the native select, preserving accessible naming, focus and interaction. Financial overview and configuration copy follows FR/DE/IT/EN. Ten fixture journeys and 66 geometry checks pass, including 320px German at 200%, 800px tablet and 844px landscape. Compact and expanded navigation now share the 860px breakpoint, preserving all destinations at intermediate widths; focus outline and Tab exit are checked. The web build passes. Long title/word breaks and physical assistive-technology testing remain separate. See `docs/FINANCES-SYNTHESE-LANGUES-20260929.md`; not included in public 1.90.9.

The accounting introduction reserves a readable text column before wrapping its configuration action. Enlarged titles request language-aware hyphenation without reducing the selected size. Five Edge/WebKit viewport cases confirm the introduction width and disclosure/configuration controls, with synthetic data. Windows browser dictionaries did not visibly hyphenate the long French/German titles; those breaks and remaining untranslated accounting copy remain open. See `docs/COMPTABILITE-LISIBILITE-20260929.md`; this local refinement is absent from the frozen 1.90.9 release.

## Narrow touch-target correction — 27 September 2026

Existing mobile navigation, screen help, calendar period arrows and Automation activity filters now provide at least 44 × 44 CSS px below 861 px. Icons and business actions are unchanged. The header help target aligns with the title and cannot overlap invoice creation. Desktop sizing is preserved.

`tests/mobile-touch-targets.mjs` verifies taps three pixels from the left edge, menu opening/closing, help and Escape after focus settles, calendar navigation, activity filtering and no horizontal overflow. Twelve screen captures cover WebKit 320px DE/light and 390px FR/dark, Edge 768px IT/light and 1440px EN/dark. Scoped detector returned no findings; TypeScript and the web build passed. This is a bounded polish pass, not a new visual system or an independent whole-app review. Touch is simulated in browsers; physical devices and screen readers remain separate validation.

## Financial first steps — 27 September 2026

Distill/refinement, not a replacement world. Accounting and banking show one setup action before empty statistics. Previously recorded entries and bank movements stay visible. Reminder activity comes before setup; removing all active templates must not hide existing reminders. Summary detail follows the queue, sending still requires explicit approval, and loading failures never masquerade as empty companies.

`FinanceFirstStep` is a plain section using the existing type, color and button system. New copy is translated in FR/DE/IT/EN. Two bounded visual rounds flatten the reminder panels and preserve actions at 320px with 200% text. 27 browser checks and 64 focused unit tests pass; build and scoped detector pass. Fixtures simulate native calls and physical devices are not certified. Older accounting navigation translations remain a separate issue. Full evidence and publication boundary: `docs/FINANCES-PREMIER-PAS-20260927.md` at repository root.

## Backup recovery refinement — 27 September 2026

Manual backups show the last successful copy, then create/restore actions. Folder and recovery preferences remain available in a disclosure, without the redundant local-database card. Restore confirmation names the selected file. A completed restoration followed by a failed read opens read-only recovery instead of replaying the restore. New copy has FR/DE/IT/EN entries; the older cloud panel still needs localization.

Two bounded visual rounds, 16 fixture journeys across WebKit 390 FR/light and 320 DE/dark at 200% text, plus Edge 1440 FR/dark. Existing type/colors/actions retained; no new image assets or visual world. Unit and build checks pass; this is not an independent whole-app review or physical-device validation. Native recovery evidence and publication boundaries are in `docs/SAUVEGARDES-RECUPERATION-20260927.md`.

## Mobile collections refinement — 27 September 2026

Client names lead to their folders; contact data and management actions unfold beneath each record. Project names lead to folders, with figures and actions in one disclosure. Sales rows keep amounts, status, dates and preview visible while the bank reference moves into mobile metadata. Desktop tables, business callbacks, permissions and printed documents are preserved.

Two visual rounds, 20 screen journeys and 30 focused unit tests passed, including four languages, both themes, read-only client actions and 200% text. Scoped detector and web build pass. Two sample client/project rows fit at 390 × 844; the second sales document starts in view but does not fully fit. Historical tab labels still break mid-word at 200%; this remains a separate accessibility refinement. Native services are fixture-based, with no physical-device or new-installer claim. See `docs/LISTES-MOBILES-20260927.md`.
