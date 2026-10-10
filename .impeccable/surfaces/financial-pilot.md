---
version: 1
slug: "financial-pilot"
primary_target: "components/account/us-financial-pilot.tsx"
related_targets: ["components/account/us-financial-pilot.css", "lib/international/browser-us-financial-pilot-copy.ts"]
---

# Zentra US — private financial pilot

Operate mode. Extend the incumbent account workspace; preserve its green identity, system typography, account tokens and light/dark preferences. No global visual-world replacement, new imagery or marketing claim.

The owner wants an Apple-inspired, spacious and clear ERP on desktop and mobile. Financial work must remain precise: invoices, receipts, credits and outstanding amounts are distinct. A restrained open register, explicit invoice detail and inline payment form let a person scan, inspect and record a receipt without a modal. Reports expose their dates, actual ledger accounts and current receivables separately. Small TEST identification describes actual availability rather than implying financial certification.

Use the existing `--ac-*` colors, typographic rhythm, 44px or larger actions and visible focus. On mobile, summaries and forms stack; only navigation and genuinely wide accounting tables scroll horizontally. Preserve safe-area spacing, address lines, notes line breaks and exact monetary strings. French, German, Italian and English labels share the same component. US financial formats remain US formats independently of interface language.

The authored movement is a short invoice-detail arrival. Respect reduced motion. Polling is silent; avoid replacing the workspace with a loading panel. Preserve drafts and require explicit review when the revision changes. A payment with an unknown result can only be retried as the same request. Denied access clears displayed financial data and offers sign-in.

This is a code-led extension, not an approved image comp. Local visual evidence uses fictitious company data and actual memory-kernel transitions with synthetic authority. PostgreSQL and real socket tests are separately identified; visual QA does not prove hosted authentication, concurrent PostgreSQL connections, native behavior or regulatory compliance.

Finish evidence and the independent review verdict are recorded with the delivery. Existing global design documentation is preserved; documentation drift outside this extension is not repaired as a side effect.

## Implemented extension and verification — 2026-10-10

The implementation inherits the account font stack and light/dark `--ac-*` aliases; it introduces no font, palette, raster asset or global style. The register stays open, the invoice document has a restrained boundary, and payment entry remains inline. Local mobile adaptation at 760px stacks the summary, document parties and forms; the navigation and accounting tables contain their own horizontal scrolling. Payment and report fields are at least 46px tall, task actions use the account button, and text actions retain the 44px floor. Monetary values use exact USD minor-unit strings and tabular numerals. Four interface languages share one component; document dates and USD display use `en-US`, while native date controls retain ISO values and the browser's presentation.

Revision changes preserve the payment draft and require an explicit current-balance review before submission. An uncertain result locks editable payment controls and offers the same-request retry. Report display is bound to its revision, date range and selected ledger account; changing those inputs suppresses stale tables until reports are generated again. Three-second head polling keeps the workspace in place and leaves its sync label unannounced. Access denial clears financial content and offers sign-in.

The independent finish review at `.qa/us-financial-pilot/design-finish-review.md` records **ship**, limited to the private test component. Its 20 required valid PNGs are in `.impeccable/review/financial-pilot/`: 16 language/theme register-and-payment captures, plus reports, desktop/mobile general ledger and German 320px payment. `matrix.json` describes the 16 core captures; supplemental captures have adjacent DOM evidence. `browser-flow-proof.json` and flow DOM separately record draft preservation, balance review, uncertain retry, cleared access and report date-range invalidation. The one existing TSX detector result is `[]` in `.qa/us-financial-pilot/ui-detector-final.json`; it was not rerun for documentation.

This evidence renders the actual component with a memory financial kernel, fictitious data and synthetic authority. It is not hosted authentication, PostgreSQL concurrency, native-device or regulatory proof. Full regression and quality checks remain pending at this documentation handoff; the visual verdict does not claim their success. Global product/design documents and styles remain authoritative for their existing scope and were not rewritten.
