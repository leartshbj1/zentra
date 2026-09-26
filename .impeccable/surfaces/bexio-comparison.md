# Comparison and bexio import

Modes: Persuade for /comparatif/bexio, Read for the migration guide, Operate for the application import. Ordinary extension of Zentra Studio. The current request is to bring Zentra's verifiable advantages forward; native import behavior stays unchanged. No new style choice or image comp is needed.

## Direction contract
THESIS: Make the reasons to choose Zentra immediately clear: Gestion functions included from Solo, the same feature scope across team sizes, and the linked Gestion/Support/Automation workflow. Support the decision with comparable facts and a usable migration guide.
OWN-WORLD: Existing white/pearl Studio surfaces, forest green actions, Geist, quiet rules and generous space. Preserve the native app theme tokens.
STORY: Lead with Zentra's entry-plan advantages, explain what a received invoice and appointment become, compare functions with a readable highlighted Zentra column, then compare regular monthly prices and prepare the bexio import.
FIRST VIEWPORT: A left-aligned product choice and concrete entry-plan promise beside three open proof rows. The primary action chooses Zentra; the secondary action jumps to differences. On mobile the promise and actions precede those proof rows.
FORM: Incumbent Studio extension, code-led, no imagery required for this factual comparison. The signature reading interaction is the comparison anchor: the highlighted Zentra column turns into explicitly labelled pairs on mobile. Preserve native import behavior.
FINISH: The Zentra-first website extension is finish-reviewed with disposition ship for the supplied states and documented below. Preserve the incumbent DESIGN.md and .impeccable/design.json; this extension establishes no new visual world and adds no shipping raster assets.

## Implemented fit with Studio

Checked `app/comparatif/bexio/page.tsx` and `comparison.css` against PRODUCT.md, DESIGN.md and the six current `bexio-advantages` captures. The shared header, footer, Geist typography and actions retain Studio's white/pearl surfaces, forest green, fine rules and open content. The asymmetrical hero places the entry-plan promise and actions beside three open proof rows. A pearl workflow section explains the received invoice and appointment before the feature table, whose tinted Zentra column brings the benefits forward. Pricing retains comparable facts, regular and promotional terms, and the pack's scope. Numbered export steps and an expandable scope explanation keep the migration guide readable.

Below 760px, the promise and actions precede the proof rows; workflow and pricing columns stack. Each comparison need becomes an explicitly labelled Zentra/bexio pair, retaining the tinted Zentra treatment. These are adaptations of Studio's open editorial composition, not a new card system. Local type sizes and green/muted tone differences remain surface details, not new global tokens.

Historical native fit, retained from the initial import pass: `desktop/src/BexioImportPanel.tsx` and CSS reuse the app's Button, Field, ErrorPanel and theme variables. The company name, three data choices, file control, column mapping and selectable preview lead to one explicit add action. Existing-name duplicates stay excluded; invalid selected rows block submission. A receipt distinguishes saved data from a refresh failure and offers a refresh without submitting again. Below 600px, mapping fields and row metadata stack. Desktop light and narrow dark fixtures retain the same hierarchy. This website extension does not revalidate or change that implementation.

## Product scope and sources

Clients, suppliers and catalog are in scope. Historical invoices, quotes, payments, accounting entries, balances, attachments, secondary addresses, contact links, stock levels and tiered prices are excluded. CSV, TSV and XLSX files are reviewed locally, with stated limits of 20 MB and 5,000 rows; no bexio API secret is requested. Catalog tax codes require verified rates and prices in CHF.

The page records source consultation on 26 September 2026 and links the official [bexio prices](https://www.bexio.com/fr-CH/packages-et-prix), [package comparison](https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf), [export guide](https://help.bexio.com/s/article/000001647?language=fr), [contact structure](https://help.bexio.com/s/article/000002422?language=fr) and [product structure](https://help.bexio.com/s/article/000001781?language=fr). It distinguishes monthly from annual billing, user counts and VAT treatment, and discloses that Zentra wrote the comparison without bexio affiliation. This documentation pass checks the recorded sources and implementation; it adds no independent price verification.

## Historical finish evidence — initial import pass, 26 September 2026

The finish reviewer accepted six settled captures: site `.impeccable/review/bexio/{desktop,desktop-intro,mobile,mobile-intro}.png`, and native `.impeccable/review/bexio/{desktop,mobile}.png` under `C:/Users/alb/.codex/worktrees/zentra-automation-native-20260920/chantier`. The website was captured in Edge at 1440px and WebKit at 390px; the native browser fixture uses desktop light and narrow dark themes. These are review evidence, not shipping image assets.

The scored material issue was a Windows/version prerequisite hidden inside the scope disclosure. The final source places the Windows 1.90.0 prerequisite above the numbered import steps, visible without opening the disclosure, while retaining the detailed reminder. The finish-review handoff marks this issue resolved and gives **ship at the scored-fix scope**. That verdict covers the supplied states and this correction, not release availability.

Existing checks reported by the implementation handoff: site TypeScript `noEmit` passed; the native full frontend suite passed **1,688 tests in 213 files**, confirmed in native `outputs/bexio190/frontend-tests.log`. A subsequent XLSX browser check exposed loss of leading zeros from Excel numeric formats; the parser correction and regression passed **5 bexio and 21 catalog tests**, then the XLSX fixture passed with postal code `0123`, reference `00042`, accents and contact names preserved. The full suite was not repeated after that correction. Native source snapshot: `614e8f39cdfe11ba57972d4ed07539f6d641724e`; no visual change was reported.

Native `outputs/bexio190/ui-check.mjs` exercises duplicate exclusion, invalid-row blocking, client and supplier submissions, preservation of a leading-zero postal code, and recovery from refresh failure without a repeated import. The actual panel runs against a synthetic bridge and fictitious data. The website check, `outputs/bexio190/site-check.mjs` in the native worktree, exercises the guide anchor and scope disclosure. Both route checks reported no horizontal overflow or page errors.

In the HTTP-only site preview, the test response interceptor removes `upgrade-insecure-requests` so WebKit can load local resources; production source security is unchanged. The website detector ran once and reported advisory type/color differences; no native detector pass is claimed. This document adds no new test run, capture or broad drift repair.

## Current extension evidence — Zentra-first comparison, 26 September 2026

Scope is the marketing page and its stylesheet. The documenter checked `outputs/bexio-comparison-20260926/verification.md`, `results.json`, the final page/CSS and all six settled captures: `.impeccable/review/bexio-advantages/{desktop,mobile}{,-intro,-comparison}.png`. The fresh finish-review handoff reports **ship**, with the hero, workflow, comparison, pricing and import guide matching the direction contract, including their mobile adaptations; no material fix was requested.

The verification record reports TypeScript `noEmit` passed; the implementation handoff also reports the brand-assets check passed. `results.json` records successful Edge layouts at 1440, 1024 and 768px and 200% zoom, plus WebKit at 390 and 320px, with no page errors or horizontal overflow. Pricing/pack destinations, comparison/import anchors and keyboard disclosure passed. Captures use reduced motion and settled fonts. The HTTP-only preview retains the test-response CSP exception described above without changing production security.

The current extension ran the detector once; findings were advisory type sizes and green/muted tones only. The page consumes Zentra plan constants for regular prices, seats and pack scope. The verification record distinguishes bexio's regular monthly and annual prices from the promotion observed on 26 September, states workflow dependencies, and retains the bank-connection and Swissdec limits. This documenter pass reconciles that recorded evidence with the implementation; it performs no independent live price check, new browser run or drift repair.

## Release limits and document boundary

The initial import handoff had no real bexio account/export test, and cloud Rust checks and native packaging were then still in progress; those are historical limits, not a fresh native status check. The current website extension performs no native release, customer-data mutation or real-export retest. Its publication is still pending at this documentation handoff. Neither the historical fixture/tests nor the current visual verdict proves production availability, successful installation or migration of a real business. The guide retains the Windows 1.90.0 prerequisite; publication and distribution require separate evidence.

Only this surface brief is updated. Site PRODUCT.md, DESIGN.md and `.impeccable/design.json` are preserved; native documentation and all implementation files are unchanged by this pass. No new raster assets or visual-system rules are introduced.
