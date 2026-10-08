# Native US alignment — source audit, 8 October 2026

This is a read-only source audit, not a native execution, distribution or production certification.

## Inspected sources

| Surface | Checkout | HEAD |
| --- | --- | --- |
| Shared web engine | `D:/Codex-Zentra-Temporary/2026-10-08/international-site` | `42d516ad70d8547a8914f19daa5597b5ce2d00b9` |
| Native US pilot | `D:/Codex-Zentra-Temporary/2026-10-08/international-native` | `0f53e632982fdc9cdc43d5e5a322aa33cb565571` |
| Current CH corrections | `D:/Codex-Zentra-Temporary/2026-10-08/app-current-corrections` | `56daec734529c06bae6dd73729c74b3a655edb86` |
| Preserved integrated CH app | `D:/Codex-Zentra-Temporary/2026-10-04/quality-followup/app-integrated` | `596a3f2ba1b65e2fe599a7996bd638d104a0d53d`, app 1.90.15 |

The checkouts were clean at inspection. No source copy, file edit, test, migration, native compilation or distribution was performed during this audit. This document was subsequently added to the web implementation lot.

## Current native path

`desktop/src/WorkspaceApp.tsx:5097` mounts `useInternationalErp` inside SettingsScreen; the pilot is exposed at `:5382`. The ordinary projects (`:2188`), sales and reports (`:2609`) still use the historical CH `Workspace`/SQLite models. `desktop/src/useInternationalErp.ts:21-24` starts polling on mounting Settings and stops it on leaving. `internationalErpSession.ts:108-117` already provides a visible-app three-second revision check, backoff, delta reconstruction and origin fencing.

The pilot can prepare USD customers/estimates and recorded payments under server authority. It is not a complete US native edition. Its accounting panel is a preview; it does not expose all five server reports or portable exports. Formats are hardcoded to en-US (`InternationalErpPilot.tsx:44-45`) despite four translated interface dictionaries.

## Blocking contract gaps

1. **Admission:** web US creation uses `international_workspace_members` and its own SaaS authority. Historical device approval/poll uses `organization_members`, CHF subscriptions and installation licences (`app/api/account/device/approve/route.ts:37`, `lib/account.ts:152-205`). `runtime-bindings.ts:37-38` explicitly documents the future US-native session issuer. A country-aware issuer must preserve the CH path and validate US membership/product/seat/revocation freshly; copying US membership into a CH subscription is not an acceptable shortcut.
2. **Schema:** native `internationalErp.ts:90` and Rust `international_erp.rs:72/93/99/110` strictly accept schema 1. `account_cloud.rs:229-240` does not announce a higher protocol capability. Schema2 purchasing books cannot be read by that client. Header, pure types, TS/Rust validators, receipts, head and deltas must change together while preserving old schema1 books and replay.
3. **Visibility:** the shared US controller must be lifted to the selected-company shell so every US menu sees one authoritative state. CH SQLite must not become a parallel US financial book.
4. **Sales:** native financial actions are presented under binary readOnly rather than the precise three financial roles. Issuance remains unavailable in production until a trusted tax provider is actually bound (`runtime-bindings.ts:63`); a configured profile is not a provider. Add explicit review, stale-review cancellation and exact pending recovery to the native UI.
5. **Exports:** native has only the four JSON ERP IPC commands. Add bounded fixed-route export/seller/tax ports, protected-session pre/postflight checks, MIME/org/USD/language/revision/selector digest and content hash verification. Keep bearer credentials in Rust and do not widen the WebView CSP or place tokens in URLs to bypass the port.

## Projects: one engine, schema3

The next web implementation puts projects in the same ERP schema3, CAS, audit and delta stream. The registry owns customer, explicit name, notes, planned dates, exact net USD budget and vendor-bill associations. Sales retain real project IDs; linked balances come from invoices/payments and recorded bills. Legacy IDs must be explicitly named and reviewed as one complete promotion batch; no fabricated project names or second project authority.

Reusable native presentation references:

- `WorkspaceApp.tsx:3070` ProjectsScreen: search, status filters, pagination and folder entry.
- `ProjectFolder.tsx:19`: folder navigation and linked files/sales/purchases/notes.
- `ProjectPlanningPanel.tsx:127`: tasks, milestones and contextual correction.
- `ProjectReports.tsx:13`: report section selection and preview.
- `MobileDetails.tsx`, project styles and translations: progressive mobile disclosure.

Reuse the visual vocabulary and shell. Do not directly reuse their CHF calculations, `Workspace` field types or SQLite transports for US. For example, `types.ts:45` fixes billing currency to CHF, and legacy invoice issuance validates a Swiss IBAN (`database.rs:3764`). No uploaded-original-document or offline-write capability should be claimed from a registry/export feature alone.

Six existing pure-domain files differ between native and web: `erp-request.ts`, `invoicing.ts`, `runtime-sync.ts`, `runtime-types.ts`, `runtime-validation.ts`, `countries/adapters.ts`. Align these through a versioned shared contract/package or source manifest and cross-consumer tests. Never import web server/D1/Supabase credential bindings into the native frontend.

## Minimum complete technical milestone

Native country-aware account/workspace admission → US customer/project → project-linked USD estimate → acceptance → private TEST-only invoice issuance → partial received payment → exact linked project balances → all five accounting reports and verified project/document export. Every active menu observes the same revision/delta session. Real production issuance stays closed until a trusted fiscal provider and required commercial admission are available.

Future validation must cover TS/Rust contract compatibility for schemas1/2/3, flag closure during reads, three-second unchanged-head behavior, interrupted exact retries, Auth/role/company race purges, legacy reference promotion, four languages/themes and mobile/large text. Separate CH checks must preserve QR invoices, VAT, historical SQLite data, payroll and account licensing. A staging multi-instance/device test is required before making real multi-device production claims.

The current CH Agenda, Notes and fixed-assets corrections were already identical in the native US and current-corrections checkout for inspected shared files. There is no reason to copy an older desktop tree. No native implementation is included in this web lot.
