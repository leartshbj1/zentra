# Zentra — coherent pages, less reading

Mode: Persuade on product pages, Operate on account and tools, Read on legal/security. Extend the user's approved Apple-inspired Studio world and code-led preference; no new identity round. The user's phone capture specifically rejects Gestion's version/platform/specification block. Remove it entirely.

## Direction contract

THESIS: Each page answers one question and reveals its next useful step. The product family reads as one site, without repeated specification cards or oversized navigation inventories.
OWN-WORLD: Existing Geist, forest green, white and pearl. Flat controls, precise separators, 12–16px surfaces. No new illustrations or decorative glass. Quiet monochrome document examples identify themselves as fictional.
STORY: Understand Gestion through a quote-to-payment example, discover modules without a wall of text, choose a product or plan, then enter a consistent account workspace. Preserve real prices, dependencies, legal text and business behavior.
FIRST VIEWPORT: Product name stays in navigation; one clear headline, a short explanation, one primary action. Gestion's next section is a working document journey, not version statistics. On iPhone, controls stack, guides and detail lists disclose on request, footer groups collapse.
FORM: Continuation of the explicitly pinned Studio / Apple direction. Recompose Gestion and the reading pages, harmonize every route family through its own shared shell, and preserve the recently approved concise download flow.
MOTION: User-driven document-stage changes, small disclosure transitions, existing reduced-motion support. No content hidden behind entrance effects or unnecessary parallax.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Coverage and evidence

Inventory all actual page routes and aliases. Inspect marketing, pricing, legal, authentication, account settings, Automation and Support shells. Validate desktop and narrow mobile layouts, navigation, disclosure, demo interactions, and existing authentication/download/support tests. Use local fixtures for connected UI when production credentials are unavailable; do not represent fixture checks as live billing or account verification. Keep local preview setup separate from production.

## Implementation notes — 24 September 2026

This is an ordinary extension of the approved Zentra Studio system. `DESIGN.md` and `.impeccable/design.json` remain unchanged: their forest-action palette, Geist hierarchy, open editorial rows, restrained depth and functional surface radii still explain the built presentation. `app/page-system.css`, imported after `studio.css` and `intuitive-site.css`, supplies the page-specific refinements. These notes describe that extension; they do not establish additional global tokens.

Gestion replaces the version/platform/specification block with the explicit fictional quote → invoice → recorded-payment example in `components/gestion-experience.tsx`. Three user-operated buttons expose their selected state; the explanation announces changes, and the next-step control supports keyboard operation. The content identifies a fictitious client and project. The document's short arrival animation is disabled for reduced motion. No generated raster is used by this extension.

The main page container is capped at 1160px. Its gutters reduce from 40px to 24px, then 20px at 760px and 16px below 359px. Two-column sections become a single column; the primary action fills the mobile width. Product-page headings use a local 42–72px fluid range, reduced to 36–46px on mobile, with 540 weight; section headings use 32–48px. These surface-specific sizes coexist with the incumbent home-page ramp rather than replacing it. Buttons remain flat with 48px minimum primary height and 44px text-link height; surfaces use the incumbent 12–16px range.

`app/features/page.tsx` and `app/security/page.tsx` retain detailed content inside native disclosures. `components/page-disclosures.tsx` opens the relevant feature disclosure when following a hash link. The shared legal component offers a mobile contents disclosure while retaining full legal sections. `components/site-footer.tsx` folds each link group on mobile with `aria-expanded` and `aria-controls`; the desktop inventory remains visible. Shared account, authentication, Support and pricing shells reuse the Studio palette, simpler surfaces and readable field sizing without defining a new visual world.

## Evidence disposition

The source pass checked `PRODUCT.md`, `DESIGN.md`, the schema-v2 sidecar, the final CSS import order, `studio.css`, `page-system.css`, and the Gestion, feature, security, legal, footer and disclosure components. The local Gestion first-viewport captures at 1440px and 390px were visually inspected for system fit. The reports and screenshots are under `.impeccable/review/site-pages/`; they are local review evidence, not proof of production publication.

- `edge-report.json`: 51 route variants at 1440px and 390px; 307 completed assertions, none failed, no page overflow. Four initial Support `networkidle` timeouts remain recorded. `final-report.json` contains 12 targeted HTTP/overflow rechecks using document readiness; a loading heading alone does not establish a ready authenticated Support workspace.
- `webkit-report.json`: 14 representative routes at 390px and 320px; 97 passing assertions and no reported runtime error or page overflow. Feature showcase tabs are an intentional horizontal scrolling strip; their clipped offscreen labels are not evidence that every item is simultaneously visible.
- `detail-report.json`: 24 account-fixture and expanded-content overflow checks at the reported desktop/mobile widths. The connected screens use synthetic local data. Support's separately captured signed-out state uses local 401 fixtures; the public demo is independently covered. No live authentication, billing, provider delivery or Automation execution is established by these captures.
- `verification.md` records successful TypeScript, 73 targeted tests, changed-route/component lint and brand validation. It records the independent final verdict as `ship` after the Gestion heading's isolated question mark was fixed with nonbreaking French spacing and recaptured at 1440px, 390px and 320px.

## Drift not promoted to the system

The detector records 60 advisory deviations: 58 font-size entries, one local color and one 6px status radius. These do not authorize expanding the normative token ramp merely to silence the detector. Small inherited feature-demo and archive labels, existing local green/focus variants, and the navigation's explicit system-font cascade remain local implementation differences; they are not new display-font or metadata recommendations. Existing documentation describing Support's system font is historical after this extension's explicit Geist override. The sidecar's 380ms compact-document motion remains specific to its original component; Gestion's 280ms transition is a local variant. None of this drift was repaired or canonized by the documentation pass, whose write boundary is this surface record only.
