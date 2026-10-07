# Zentra US native pilot — 8 October 2026

## Scope and admission

The pilot belongs to the existing native application on branch `codex/international-runtime`, based on native `596a3f2ba1b65e2fe599a7996bd638d104a0d53d` and gateway `587b5f1f45a39ada6112cbbcf2aceb194ac20636`. It is explicitly experimental, not certified accounting or tax software. No installation, publication, production request, data deletion or Swiss financial migration was performed.

Settings renders immediately using its existing data. A separate, asynchronous admitted gateway read can expose **Zentra US · Experimental** only after the server returns confirmed **US/USD company configuration**. A Swiss configuration, disabled server feature or rejected/unavailable discovery does not expose the entry and does not block other Settings. Discovery never initializes a company. The company's country is not selected from the user account, locale or device.

Each gateway call obtains the organization and bearer from the protected native device session. IPC accepts the captured workspace scope and member nonce, not a tenant, token, URL or role. Server membership, subscription and workflow authority remain mandatory. Preflight and postflight reject an in-flight reply when the member, workspace or credential changes. A POST authorization/subscription/session refusal removes previously cached financial data from this session. The existing CH commands and SQLite schema are unchanged.

## Available pilot flow

- Read real server state or uninitialized confirmed configuration; review the company's address, currency, time zone and accounting basis.
- Initialize only after explicitly entered accounting-period dates and confirmation. Company settings and authority are never supplied in this command.
- Save US customers with billing address, state, ZIP, contact and payment terms.
- Create a USD estimate with exact prices, fractional quantities, discounts, tax treatment, notes and dates; accept an estimate and request invoice issuance.
- Show issued invoices and their immutable public seller/customer snapshots; preserve notes and payment history. No CHF or Swiss QR section is injected.
- Record partial payments with distinct transaction/payment and accounting dates and an explicit open accounting period.
- Preview the journal, trial balance, profit and loss, balance sheet and cash movement from the validated shared ledger.
- Present fixed, translated recovery instructions in French, German, Italian and American English. Customer names, descriptions, references and document data are not translated.

Issuance still requires authoritative seller configuration and an available validated sales-tax provider or documented exemption path on the server. A `configured` tax status alone is insufficient. The UI cannot send a tax assessment, rate, role or replacement configuration. Missing seller/tax configuration receives a specific explanation; the estimate remains stored. No US rate table or invented default zero tax exists in this real flow. The synthetic visual fixture's historical invoice and zero assessment are explicitly QA-only.

## Synchronization and recovery

Besides the existing full GET and command POST, fixed IPC reads expose:

- `read_international_erp_revision(...)`: `GET /api/international/workspaces/{serverOrganizationId}/erp/revision` → scoped head or null.
- `read_international_erp_changes(afterRevision, limit, ...)`: `GET .../erp/changes?after=N&limit=L` → scoped delta or null. Limit is 1–100, default 100.

The first read is a full validated snapshot. While the Settings-mounted member session is active and the window is visible, the controller checks the small head every three seconds. An unchanged head retains the exact snapshot and does not notify React, clone data, replay the ledger or fetch the full book. A changed head applies only validated deltas, with contiguous revisions, scoped entities, immutable archived invoices, exact amounts and balanced journals. Invalid/incomplete deltas leave the previous verified cache intact and display a recovery error. Full rereads happen for explicit refresh or a server `resetRequired`, not periodic polling. Focus and successful mutation also trigger a check. Hidden windows do no polling; failures back off up to 30 seconds. Teardown and operation epochs discard stale responses.

POST is never automatically retried. An uncertain transport/protocol outcome retains the exact immutable request/key/revision. An explicit retry reuses it, letting the server reconcile idempotently. A verified head/delta recovery clears stale synchronization errors without sending another POST. Financial and identity fields are not added to logs; diagnostics use the existing redacted gateway.

The native gateway also applies the server's pure public projection after validation: current/uninitialized company profiles, archived invoice profiles and delta headers never retain an EIN in the frontend cache. Invoice tax evidence is restricted to an explicit public proof allowlist. Unknown provider debug fields cannot become visible cached financial state; full snapshots fail closed if their stored reconstruction is inconsistent. Projection copies the wire data without changing the private store, monetary values, journals or idempotent receipts.

## Files

Created native code:

- `desktop/src/InternationalErpPilot.tsx`, `international-erp-pilot.css`: real pilot views using the existing opaque Apple-style Settings components and theme tokens.
- `desktop/src/internationalErpForms.ts`: exact input parsing and company-time-zone dates.
- `desktop/src/internationalErpSession.ts`, `useInternationalErp.ts`: admitted session lifecycle, scoped async discovery, incremental synchronization and explicit request recovery.
- `desktop/src/translationsInternationalPilot.ts`: authored DE/IT/EN interface translations.
- `desktop/src/InternationalErpPilot.test.tsx`, `internationalErpSession.test.ts`, `internationalErpSync.test.ts`: UI, recovery, races, synchronization and translation tests.
- `desktop/tests/international-native-fixture.ts`, `international-native-pilot.html`, `international-native-pilot.tsx`, `international-native-visual.mjs`: isolated fictitious QA surfaces. Production entrypoints do not import these fixtures or replace the real gateway.

Modified native code:

- `desktop/src/WorkspaceApp.tsx`, `translations.ts`: optional Settings entry and language pack inclusion.
- `desktop/src/internationalErp.ts`, `internationalErp.test.ts`: complete state validation, fixed head/delta bridges, safe error allowlist and protocol tests.
- `desktop/src-tauri/src/account_cloud.rs`, `international_erp.rs`, `international_erp_gateway_tests.rs`, `lib.rs`: bounded fixed routes, protected request admission and registered read commands.
- `desktop/src/dark.generated.css`: existing generator's status-color rule for the pilot.

Shared pure domain modules synchronized from the main international core: `runtime-types.ts`, `runtime-sync.ts`, `runtime-validation.ts`, `erp-contract.ts`, `erp-request.ts`, `invoicing.ts`, `public-projection.ts`, `accounting/postings.ts`, `accounting/reports.ts`. None imports a server runtime, credential store or database client into the native frontend. `desktop/src/internationalErpPrivacy.test.ts` adds four projection/privacy checks. The fictitious invoice fixture normalizes its country/address configuration before generating a tax fingerprint, matching the authoritative runtime.

No native or server migration is proposed by this UI change. The root server project owns additive runtime/delta migrations and feature activation separately. Rollback is removal/reversion of this isolated pilot commit; existing Swiss data is untouched.

## Executed checks

| Check | Result and scope |
| --- | --- |
| Native `cargo test --lib international_erp --no-run --locked --offline` | Compiled current tests successfully |
| Native `cargo test --lib international_erp --locked --offline` | **13 passed**, 1,226 filtered; temporary SQLite/session fixtures and synthetic HTTP only. The earlier Windows App Control test-binary blockage did not recur |
| Vitest six selected frontend suites | **77 passed**: gateway 14, session/forms 12, sync 12, privacy 4, pilot UI 10, existing member-origin 25 |
| Desktop `tsc --noEmit` | Passed on the complete desktop source and imported shared modules |
| Desktop `build:web` | Passed, including branding check, dark-palette generation, TypeScript and Vite production build; existing >500 KiB chunk warnings remain |
| Browser visual matrix | **25 passed**: sales/accounting/customer/estimate/initialization in desktop 1440 light EN, mobile 390 dark EN/IT, 390 light FR, 320 light DE at 200% root font. No page errors or viewport overflow. The fixture uses actual application scope classes and CSS; initial incomplete-harness captures are not delivery evidence |
| Impeccable detector | No findings on the new component/CSS; existing project sidecar/brief drift was reported separately and not repaired as a side effect |
| `git diff --check` | Passed |

Current screenshot evidence is local and ignored by Git under `desktop/.impeccable/review/international-native/`, including `1440-light-en-sales.png`, `390-dark-en-sales.png`, their accounting/form variants and the 320 DE captures. These are fictitious visual evidence, not live multi-device or production performance proof.

## Remaining delivery gates

This is an additive pilot, not a complete US commercial release. Company-country onboarding/confirmation is not yet connected in the native setup wizard; an explicitly confirmed server company profile and feature flags are prerequisites. The server remains the authority for ownership, tax/provider readiness and subscription admission.

US vendor invoices, purchase orders, credit notes, recurring invoices, production PDF/email generation, document branding asset resolution, banking/payment-provider integration, Automation bridges and complete financial reports/exports are outside this pilot UI. A hosted tax provider and real customer-invoice payment architecture remain separate work. No production subscriptions, country prices or webhook settings were modified.

Live server/device authentication, RLS, production tax provider, real subscription, offline reconciliation, multi-device load and physical macOS/iOS/Android behavior were not exercised here. Native offline writes are deliberately absent from this server-backed US pilot. This change supplies a usable protected path in the existing application for subsequent staging/pilot validation; it does not claim US GAAP certification, SOC 2, legal compliance or production readiness.
