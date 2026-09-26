# Comparison and bexio import

Modes: Read for /comparatif/bexio, Operate for the application import. This is an ordinary extension of Zentra Studio, not a replacement world. The user requests a competitor comparison and a working import from bexio. No new style choice or image comp is needed.

## Direction contract
THESIS: Help a Swiss SME choose with comparable facts, then bring its contact and catalog lists across with a review before saving.
OWN-WORLD: Existing white/pearl Studio surfaces, forest green actions, Geist, quiet rules and generous space. Preserve the native app theme tokens.
STORY: Understand the differences, compare monthly prices with their real scope, export from bexio, and review imports inside the chosen Zentra company.
FIRST VIEWPORT: A centered two-line question, a short explanation and two clear anchors above two balanced product descriptions; one column on mobile. Native import opens with three data types, a file picker and a concise scope note.
FORM: Incumbent Studio extension, code-led. The signature interaction is a transparent preview with selectable rows and duplicate suppression before one explicit import action.
FINISH: Finish-reviewed and documented at the scored-fix scope. Preserve the incumbent DESIGN.md and .impeccable/design.json; this extension establishes no new visual world and adds no shipping raster assets.

## Implemented fit with Studio

Checked `app/comparatif/bexio/page.tsx` and `comparison.css` against PRODUCT.md, DESIGN.md and the supplied captures. The shared header, footer, page typography and actions retain Studio's white/pearl surfaces, forest green, fine rules and open content. Product descriptions and prices use paired columns; below 760px they stack, and each comparison row shows explicit product labels. Numbered export steps and an expandable scope explanation keep the guide readable. Local type sizes and muted color differences remain surface details, not new global tokens.

The native `desktop/src/BexioImportPanel.tsx` and CSS reuse the app's Button, Field, ErrorPanel and theme variables. The company name, three data choices, file control, column mapping and selectable preview lead to one explicit add action. Existing-name duplicates stay excluded; invalid selected rows block submission. A receipt distinguishes saved data from a refresh failure and offers a refresh without submitting again. Below 600px, mapping fields and row metadata stack. Desktop light and narrow dark fixtures retain the same hierarchy.

## Product scope and sources

Clients, suppliers and catalog are in scope. Historical invoices, quotes, payments, accounting entries, balances, attachments, secondary addresses, contact links, stock levels and tiered prices are excluded. CSV, TSV and XLSX files are reviewed locally, with stated limits of 20 MB and 5,000 rows; no bexio API secret is requested. Catalog tax codes require verified rates and prices in CHF.

The page records source consultation on 26 September 2026 and links the official [bexio prices](https://www.bexio.com/fr-CH/packages-et-prix), [package comparison](https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf), [export guide](https://help.bexio.com/s/article/000001647?language=fr), [contact structure](https://help.bexio.com/s/article/000002422?language=fr) and [product structure](https://help.bexio.com/s/article/000001781?language=fr). It distinguishes monthly from annual billing, user counts and VAT treatment, and discloses that Zentra wrote the comparison without bexio affiliation. This documentation pass checks the recorded sources and implementation; it adds no independent price verification.

## Finish evidence — 26 September 2026

The finish reviewer accepted six settled captures: site `.impeccable/review/bexio/{desktop,desktop-intro,mobile,mobile-intro}.png`, and native `.impeccable/review/bexio/{desktop,mobile}.png` under `C:/Users/alb/.codex/worktrees/zentra-automation-native-20260920/chantier`. The website was captured in Edge at 1440px and WebKit at 390px; the native browser fixture uses desktop light and narrow dark themes. These are review evidence, not shipping image assets.

The scored material issue was a Windows/version prerequisite hidden inside the scope disclosure. The final source places the Windows 1.90.0 prerequisite above the numbered import steps, visible without opening the disclosure, while retaining the detailed reminder. The finish-review handoff marks this issue resolved and gives **ship at the scored-fix scope**. That verdict covers the supplied states and this correction, not release availability.

Existing checks reported by the implementation handoff: site TypeScript `noEmit` passed; the native full frontend suite passed **1,688 tests in 213 files**, confirmed in native `outputs/bexio190/frontend-tests.log`. A subsequent XLSX browser check exposed loss of leading zeros from Excel numeric formats; the parser correction and regression passed **5 bexio and 21 catalog tests**, then the XLSX fixture passed with postal code `0123`, reference `00042`, accents and contact names preserved. The full suite was not repeated after that correction. Native source snapshot: `614e8f39cdfe11ba57972d4ed07539f6d641724e`; no visual change was reported.

Native `outputs/bexio190/ui-check.mjs` exercises duplicate exclusion, invalid-row blocking, client and supplier submissions, preservation of a leading-zero postal code, and recovery from refresh failure without a repeated import. The actual panel runs against a synthetic bridge and fictitious data. The website check, `outputs/bexio190/site-check.mjs` in the native worktree, exercises the guide anchor and scope disclosure. Both route checks reported no horizontal overflow or page errors.

In the HTTP-only site preview, the test response interceptor removes `upgrade-insecure-requests` so WebKit can load local resources; production source security is unchanged. The website detector ran once and reported advisory type/color differences; no native detector pass is claimed. This document adds no new test run, capture or broad drift repair.

## Release limits and document boundary

No real bexio account/export has been tested. Cloud Rust checks and native packaging were still in progress at this documentation handoff. Neither the fixture, frontend tests nor visual verdict proves production availability, successful installation or migration of a real business. The Windows 1.90.0 statement describes the intended release requirement; publication and distribution must be verified separately.

Only this surface brief is updated. Site PRODUCT.md, DESIGN.md and `.impeccable/design.json` are preserved; native documentation and all implementation files are unchanged by this pass. No new raster assets or visual-system rules are introduced.
