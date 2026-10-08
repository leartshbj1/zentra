# Native US purchasing and export server verification

8 October 2026. Server baseline: `3a0ca29844650578b311ebbdcd1c508c0288ddb5`, verified against the attached selection. This slice adds a test and local cross-client response vectors only. No financial/server/domain source, migration, catalogue, production flag or deployed site was changed.

## Verified vertical and authority

The new `lib/international/native-purchasing-exports.integration.test.ts` exercises the actual US device start/approval/exchange and bearer reader, D1 SaaS/membership admission readers, runtime HTTP bindings, ERP executor, PostgreSQL store/RPCs under `service_role`, export handlers, embedded fonts, renderers and PDF decoding.

The fixture installs all 89 D1 migrations `0000..0088` in Node SQLite and 14 relevant PostgreSQL migrations from company profiles/collaboration/content through country, ERP/delta, seller snapshots, new admission, tax allowlist, seller/tax profiles, tax operations, purchasing2 and projects3. PostgreSQL is one serialized in-memory PGlite connection. D1 creation's PG confirmation receipt, browser Auth and Price/payment observation are explicit trusted TEST fixtures; this does not prove hosted end-to-end admission or real payment verification. Node SQLite uses the same TEST wall clock as the service to avoid the independently reproduced Windows second-boundary clock discrepancy; production timestamp guards are unchanged.

Owner/admin/accountant can save vendors, record manually approved bills and record partial payments. Member/read_only can read the book, public seller and exports, but cannot invoke any of those three financial commands. Private tax-profile reads remain owner-only. Native Authorization invokes only the US reader, never CH credentials or browser cookies. CH legacy D1 organization/subscription/licence/session tables remain empty in these fixtures; a pre-existing PostgreSQL CH sentinel stays byte-identical.

The tested cash and accrual books retain two bills, one payment, immutable vendor snapshots, exact cents and balanced journals. Purchase sales tax enters cost, with no US input-VAT credit. A payment is an accounting record, not bank execution. Exact duplicate supplier/reference/date, overpayment and closed-period attempts add no receipt or journal. Lost committed RPC responses and postcommit `configuration_changed409` are recovered with the identical payment body/key, even after a later vendor edit; one payment remains.

## Native export contract

Base route: `/api/international/workspaces/{organizationId}`. Credentials stay in Rust; use the fixed same-origin HTTPS route and `X-Zentra-Erp-Schema-Version: 3`. Capability is not a grant and is independently capped by the purchasing/projects flags.

- Documents: `GET /exports/documents/{estimate|invoice|vendor_bill|project}/{id}?format=pdf|csv&language=fr|de|it|en`.
- Point reports: `GET /exports/reports/{trial_balance|balance_sheet}?asOf=YYYY-MM-DD&format=...&language=...`.
- Period reports: `GET /exports/reports/{profit_loss|cash_flow}?start=...&end=...&format=...&language=...`.
- General ledger additionally requires `accountId`. Duplicate/unknown parameters are rejected; the request contains no document, amounts, role or provider proof.

Selectors are exact `{kind:'document',documentType,id}`, `{kind:'report',reportType,asOf}`, `{kind:'report',reportType,start,end}`, or `{kind:'report',reportType,accountId,start,end}`. `X-Zentra-Export-Selector-SHA256` hashes UTF-8 **canonical JSON with recursively alphabetically sorted keys**, not insertion-order `JSON.stringify`. Document example: `{"documentType":"vendor_bill","id":"bill","kind":"document"}`.

Required response correlations: `X-Zentra-Content-SHA256` (hex SHA256 of exact response bytes), `X-Zentra-Organization-Id`, `X-Zentra-Currency: USD`, `X-Zentra-Export-Language`, `X-Zentra-Export-Format`, selector hash, `X-Zentra-Erp-Revision` and `X-Zentra-Ledger-Revision`. `X-Zentra-Record-Revision` is present for estimate/bill/project and absent for invoice/report; it is never a synthetic zero. These headers prove response correlation/integrity, not financial authority.

PDF uses `application/pdf`, CSV `text/csv; charset=utf-8`, and both use `attachment; filename="ASCII-safe.ext"`. The server supplies exact Content-Length and no-store/nosniff/no-referrer. CSV is UTF-8 with BOM, comma delimiters, quoted cells and CRLF; text formula prefixes are neutralized and monetary cells are exact decimal strings. PDF is actual Letter output with embedded fonts. Maximum response size is 12MiB; snapshot limits remain 1000 rows/500000 text characters/200 PDF pages and the bounded private-source JSON limit.

The final authority/role/identity/flags/capability check follows render/fonts/hash. Late native-flag closure, purchasing-capability loss or credential revocation withholds the completed bytes without changing the book. A missing source returns `export_source_not_found404` and leaves a valid session usable; it must not be treated as logout. Actual unauthorized credentials return401. Other stable errors include `seller_configuration_required409`, `client_upgrade_required409`, `invalid_request/invalid_export_selector422`, `export_too_large413`, `unsupported_export_glyph422`, `rate_limited429` and controlled503 errors. No raw errors or arbitrary filenames cross the boundary.

Current seller is required for purchases/reports/estimates/projects; historical invoice exports use their archived seller, as separately tested by the existing PostgreSQL export suite. This new native test does not issue an invoice. The production runtime provider remains absent and the facts remain unverified. The purchase PDF is an internal approval record, not the uploaded supplier original or an archive with a retention promise.

## Final evidence

One final targeted execution: **7 files, 329 passed, 0 failed, 0 skipped**, source hashes unchanged while running. Counts are not additive with superseded runs:

| File | Tests |
|---|---:|
| native-purchasing-exports.integration.test.ts | 17 |
| purchasing.test.ts | 133 |
| purchasing.postgres.test.ts | 57 |
| export-server.test.ts | 72 |
| exports.postgres.test.ts | 19 |
| runtime-bindings.test.ts | 19 |
| us-device-bindings.test.ts | 12 |

Type-aware Oxlint for the new test and `git diff --check` exit0. No new full-global suite, global TypeScript/build or native execution is claimed here; those checks belong to the phase owner.

Final logs/JSON: `.qa/us-purchases-exports/server-tests-final.{log,json}`, `server-tests-final-state.json`, `server-selection.json`, `server-integration-lint-final.log`; replay script `run-server-tests.ps1`. The first standalone execution passed16 tests before the vector case. Its initial lint exposed new harness type errors, which were corrected. A Windows PowerShell5 runner then stopped on expected diagnostic stderr, recorded as `server-harness-initial-stderr-failure.log`; corrected runner checks the actual exit and complete JSON. The pre-vector328-test run is preserved as `server-tests-before-vectors.{log,json}` and is superseded by329.

`.qa/us-purchases-exports/us-export-vectors.json` supplies eight genuine PDF/CSV response vectors (vendor bill FR, accepted/unissued estimate EN, project DE, trial balance IT), with public UUIDv4 tenant/user scope, exact headers, canonical selectors, minimum/exact revision and base64 bytes. It contains no bearer, private tax facts, provider proof or invoice grant. SHA256: `45bf6812a7516f591b357ac0fb98c67ed3dcf9f0459c64685c7c0f659079e4c7` (127322 bytes). New test SHA256: `2ed495d9347fbb41d1070f6bdb60dac4d45815c2352b58805fc466fef359c27e`.

This proves local server behavior and response compatibility only. Rust execution, native save/share destination protection, mobile sharing, physical/two-installation staging, hosted Auth/D1/PostgreSQL, real payment/provider admission and restart/crash durability remain outside this evidence. Production activation, prices and the existing CH implementation remain unchanged.
