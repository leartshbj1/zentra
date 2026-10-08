# US device approval — ordinary account task extension

Extends the existing Apple account-task system without replacing its palette,
tokens, typography or shared surfaces. Local US pilot only, default closed.
No new commercial promise or production entitlement.

## Direction contract

THESIS: Authorize the company the person consciously selected. Account identity,
the device code and the company choices are the task; no product marketing.

OWN-WORLD: Existing Geist and green account tokens, pale task ground and white
form, one page heading, readable company names and one full-width primary action.
Use existing Apple account controls, focus and safe-area spacing.

STORY: Check the signed-in email, enter the eight-character code, choose the US
company, authorize, then return to Zentra. The first company is never assumed.

FIRST VIEWPORT: Return link, heading and one-line instruction; signed-in email;
code input; a grouped company list; authorization action. Long names wrap.

FORM: Incumbent account task, ordinary extension; no alternative visual-world
selection or generated picture is needed. States use the same layout footprint.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Evidence boundary

Test actual React controls and the server factory with in-memory SQLite and
fictional Auth, PostgreSQL configuration and payment evidence. Browser evidence
does not prove physical devices, real Supabase/Auth, deployed RLS, staging or
production. No shipping raster was created. Preserve incumbent DESIGN.md and
design.json as this is an ordinary extension.

## Documentation and finish evidence — 2026-10-08

Documentation role substitution: the harness refused another fresh documenter
thread at its agent limit. An existing agent completed this bounded handoff;
the independent finish review was supplied by the backend reviewer, rather than
being represented as a new independent review by the documenter.

### Reconciliation with the incumbent system

This is an **Operate** account task in the existing "Zentra Apple — site,
lecture et espaces de travail" system and its "L’instrument de précision"
direction. PRODUCT.md's Swiss product, price, permission and Automation promises
remain unchanged. The experimental US admission page introduces no commercial
promise, new market-wide visual world or production access.

The implemented page is `app/appareil/us/page.tsx`; the interactive artifact is
`components/us-device-approval.tsx` with its scoped
`components/us-device-approval.css`. Localized strings are in
`lib/international/us-device-approval-copy.ts` (French, German, Italian and
English). These files extend the existing `apple-task-page`, `apple-task-wrap`
and `apple-task-panel` structures from `app/apple-account.css`.

- **Palette:** inherited account tokens, forest action `--ac-accent` #216448,
  ink #18382c, muted #52665c, pale ground #f2f5f3, white panel and rule #d9e2dd.
  Local aliases consume these tokens; no new global accent or palette is created.
- **Type:** Geist for the task; a 1rem body, responsive heading declared at
  1.5–2rem, 0.9375rem company detail, and a monospace device code. The actual
  shared cascade is authoritative; local font declarations do not establish a
  new universal type ramp. Long email addresses and company names wrap.
- **Named rule — Forest action:** one full-width green authorization action;
  neutral company list and separators, selected radio accent, visible keyboard
  focus. Busy, unavailable, empty, error and successful states remain task states,
  without a promotional surface or extra navigation tier.
- **Named rule — Explicit company:** show the signed-in account and code; no
  company is preselected, including when only one company is available. Submit
  stays disabled until the person selects an accessible company and enters a
  code. Success names the authorized company and directs the person back to the
  app. Errors use localized next-step text and an alert; success uses polite live
  feedback. This documents UI behavior, not a new security guarantee.
- **Named rule — Readable task:** 36rem incumbent wrapper, safe-area-aware page
  inset, 16–32px local panel inset, 12px code field corner, pill action, and 48px
  minimum local action/return/empty-state link targets. The code must remain fully
  visible at 200% text, and the company list may grow vertically rather than clip.
  No new animation or generated raster asset is introduced.

DESIGN.md and `.impeccable/design.json` are preserved. The direction contract's
finish requirement is satisfied by this scoped documentation and the incumbent
system; it does not authorize regenerating either file for an ordinary extension.

### Review and local browser evidence

The independent backend review handoff reports **ship**, after its two material
findings were resolved: the complete code is readable at 320px with 200% text,
and return/empty-state links have a 48px target. That verdict is limited to this
local UI artifact. It is not native, production or regulatory acceptance.

Evidence files:

- `.qa/us-native-admission-browser/results.json`: the opt-in browser test
  `lib/international/us-device-approval.browser.test.ts` reports one executed,
  passing test, with no pending or failed tests in that run.
- `.qa/us-native-admission-browser/evidence.json`: twelve views across French,
  German, Italian and English, each at 320, 390 and 1280px; document width equals
  viewport width, no input/button extends beyond the viewport, and the primary
  button height is 49.59375px. German 320px at 200% text reports code text width
  178.82375px within 228px available, and a 48px return target. No page errors were
  recorded. These are measured checks for the listed fixture views, not a full
  accessibility certification or an all-pages audit.
- Final capture examples: `de-320-large.png`, `en-1280.png`,
  `en-390-empty.png`, `en-390-focus.png`, `en-390-session-error.png` and
  `en-390-success.png` in the same evidence directory. German and English have
  captures; French and Italian have measured layout evidence, not saved images.

The final fixture mounts the **actual React approval component**, actual copy,
the site's stylesheet cascade and self-hosted Geist, awaiting font readiness.
It uses a local page wrapper rather than proving the authenticated Next page in
deployment. The HTTP approval call reaches the actual handler factory and
in-memory SQLite migrations; Auth, PostgreSQL configuration and payment evidence
are fictional test ports. Two requests exercise account-change refusal and
successful explicit company selection; the test checks the expected user,
absence of a bearer header in browser approval, selected session identity and
schema capability 3. Private token strings are not displayed in the checked body.

`historical-incomplete-style-fixture/` contains earlier captures made without the
complete stylesheet/font setup. They are historical debugging artifacts and are
excluded from the finish evidence. All captures are QA records, not shipping
rasters or customer screenshots. No real customer data is used.

Limitations remain explicit: no real Supabase/Auth or PostgreSQL API, deployed
RLS, native executable, physical-device or production validation is established
by this browser run. No Rust test pass or native release is claimed here.

### Existing drift retained without canonizing it

The incumbent standalone account panel is 20px in `app/apple-account.css`, while
the general DESIGN.md panel summary lists 16px; its task heading line-height is
1.18, while the summary lists 1.2. These pre-existing account-task details are
recorded as documentation drift, not promoted into new global rules or repaired
as part of this bounded extension. The shared field cascade also overrides some
local font shorthand, so rendered screenshots and computed measurements take
precedence over an isolated selector. Changes to that cascade or the incumbent
system require their own review.
