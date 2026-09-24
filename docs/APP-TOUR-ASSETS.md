# Gestion visual tour — 24 September 2026

The `/demo-facture` route now presents images of the actual Gestion React interface. It replaces the input-based invoice demonstration at the user's request. The old URL remains valid; incoming calls to action now describe a visit.

## Image provenance

The 36 WebP images in `public/tour/gestion/` are browser screenshots from Zentra Gestion 1.86.1, native source commit `7740c67f`. They show 18 main modules at 1440 × 960 and 390 × 844. They are not generated or redrawn interfaces. Only image encoding changed (WebP quality 94); no UI elements were composited, erased or rearranged.

The app's existing `desktop/tests/mobile-harness.tsx` renders `WorkspaceApp` with its production style imports. A temporary, non-shipping fixture supplied the fictional company **Atelier du Léman**, Camille Martin and Alex Morel, two projects, three quotes, three invoices, a draft order, a supplier purchase, two employees and draft payslips, recorded time, a bank movement and an appointment. Automation's existing synthetic fixture supplies its activity. Remote requests were blocked; no real company, mailbox, payment or accounting record was written.

Reports shows the selected Bellevue project; desktop Settings shows Appearance, while phone Settings shows its module list. Draft payroll is not a certified payroll example. Demonstration balances and synthetic journal responses illustrate the screen only and are not financial test evidence. Automation availability and linked Support requirements are explained beside its image.

The asset manifest `docs/app-tour-assets.json` records image dimensions, file sizes and both original PNG and shipped WebP hashes. Each image embeds its source description in EXIF. Original PNGs, the capture script and screen text/error records are retained locally under `.impeccable/review/app-tour/` and `.qa/`; the temporary native fixture is removed after capture.

## Interaction

Choose a menu from the desktop navigation or the phone selector. Device buttons switch screenshot format; the default follows the viewport. Click or press Enter on the image to enlarge it, and Escape or Close to dismiss. Previous/Next walks the 18 screens. Hash links open a particular screen. Only the selected screenshot is requested, with a retry state if loading fails. Reduced-motion preferences suppress the image entrance and smooth scrolling.

These static screenshots do not simulate editable app controls, native installation or cloud synchronization. The website authentication, checkout, app downloads and integrations are unchanged.
