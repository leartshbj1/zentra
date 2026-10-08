# Zentra US — native admission and shared ERP screens

8 October 2026. Local implementation in isolated checkouts. The international objective remains active; this milestone is not the delivery of a production-ready US ERP.

## Outcome

The native app now dispatches the selected edition **before** the Swiss workspace, licence, onboarding and snapshot gates. The existing Swiss branch retains those gates. A separate US admission stores its bearer only in the protected Rust store and opens one authoritative ERP controller for customers, projects, quotes, invoices and five financial reports. It does not manufacture a Swiss company or replicate the US financial book into Swiss SQLite tables.

An authenticated browser must explicitly select the US company that will authorize the device. Discovery metadata and a local edition choice never grant access. Each native request checks current US/USD business authority, ready creation, company configuration, role, active seats, expiry and revocation. The server never accepts a Swiss licence or device token as US authority. The owner is included in the seat limit; additional devices are not additional collaborators.

The commercial website update requested before this work was published separately from `site-business-results`, commit `5c165545fe6588bc118166dc023efd0dae39d0ee`, Sites version 354. Its copy presents time saved, fewer manual tasks, productivity and the shared ecosystem without invented percentages or amounts, and provides easier access to the demo. Its prices and features were retained. **Do not publish this older international branch over that site branch.** International production changes require merging into the current published baseline and a separate validation.

## Implementation

- New, versioned `zentra-us-device-v1` challenge/approval/exchange/me/revoke protocol; fixed same-origin browser approval and fixed HTTPS native endpoints.
- Additive D1 migration `0088_international_us_device_admission.sql`, with hashed credentials, immutable identity, commit fences and paired atomic challenge consumption/session creation. Concurrent exchanges and lost responses recover the same session rather than creating another one.
- Fresh US session authorization reused by ERP, seller, tax and export server bindings. Country configuration routes select the credential family explicitly. Existing CH token readers and licence issuance are not relaxed.
- A four-language browser approval page (`/appareil/us`) with a deliberate company choice, bounded JSON, account-change refusal, request/body deadline, keyboard focus and readable 320px/200% text layout.
- Separate Rust protected admission and selection with a member-context nonce. US read/head/delta/execute guard the selected session before and after network success **and failure**, without holding the local store lock across the network wait.
- Native schema capability 1/2/3 alignment, strict envelopes and upgrade-required refusal for newer books. No schema downgrade or field dropping.
- Shared pure international domain modules with a provenance/hash manifest. The canonical hash implementation matches the previous web hash and Node SHA-256 golden values; no server credential dependency is imported into the WebView.
- Exact LF checkout attributes for the 26 reviewed pure modules, source manifest and two cross-consumer corpus artifacts preserve their byte hashes on Windows and macOS. No unrelated checkout setting is changed.
- Native US clients, project dossiers, quote acceptance, invoices and trial balance, general ledger, profit and loss, balance sheet and cash flow share the same controller. Cash/accrual presentation remains explicit.
- Native screens reuse Zentra's identity, languages and light/dark preferences. Mobile tables can scroll within their panel; money and long labels remain bounded. Views and pending operations are cleared at a company/role/session/capability boundary.

## Completed within this milestone

The source implementation, local SQL/HTTP/browser integration and shared native frontend are implemented. Automatic head/delta updates remain active while navigating between US menus. Exact retries are retained only in the same admitted member context. Public connected metadata contains no bearer. US tax determination and real invoice issuance remain closed without a trusted configured provider.

The native tests use the actual pure ERP executor and real schema 1/2/3 full/head/delta/receipt vectors. Native preview networking and admission are fictional IPC ports: those previews are not a running Rust application or a hosted customer flow.

## Verification record

The machine-readable companion `docs/evidence/us-native-admission-20261008.json` records the exact source hashes, checks and file lists. It also preserves the first global run's worker interruption and the separate 58-test recovery, rather than calling that interrupted run a pass. Final web and native results are recorded only after execution.

Final executed results: **3,699/3,699 web tests in 102 files**, global web TypeScript and changed-source lint exit 0, production web build exit 0. The only later web changes were test fixtures/regressions; production build inputs still match their validated hashes. **101/101 native frontend tests in 10 files**, targeted US lint in 19 files, native `build:web` including TypeScript, and the short final synthetic functional journey all pass. The native wider CH lint invocation reported pre-existing diagnostics; it is not declared globally clean. The first native visual batch has 91 measured views/checks, followed by seven confirmations, with four languages and both themes. These counts describe their bounded fixtures, not all screens of the production application.

The final review also corrected two native financial recovery defects: each project bill balance now receives only that bill's payments, and a postcommit `configuration_changed` response retains the original request/key. New tests use the real executor for a multi-bill project and a payment committed before a withheld receipt; retry returns the original receipt with exactly one payment. Only local pre-IPC validation or strict precommit CAS codes free an unresolved envelope. The new US Rust mapper accepts the four CAS codes only with HTTP 409; ambiguous statuses do not become certain rejection.

The incumbent generated CH dark stylesheet was restored byte-for-byte to the native base after its generator dropped a historical Notes rule. A final Vite-only build validates the retained stylesheet without rerunning that unrelated generator; no new CH visual rule is delivered by this milestone.

After adding LF checkout attributes, the nine focused shared-domain tests pass, including one new checkout-attribute guard; their other eight cases overlap the 101-test run. The changed test's lint and another native TypeScript check pass. Do not add these overlapping counts together as independent tests. No business implementation changed after the 101-test run.

The source alignment generator now normalizes strict UTF-8 sources to LF before writing and hashing them, while retaining each raw source hash as provenance. Nine domain tests, a generator test and changed-source lint passed after this adjustment; the 24-vector corpus kept its prior byte hash. An actual fresh indexed checkout of the 29 hash artifacts with `core.autocrlf=true` then reproduced every hash and contained no CR bytes. This is cross-checkout byte reproducibility, not a macOS application execution test.

The browser review mounts the actual React approval component with the production stylesheet cascade and self-hosted Geist. The local HTTP call uses the actual handler and full SQLite migration chain. Auth, PostgreSQL configuration and payment evidence remain fictional ports. The native review mounts the actual React US shell and shared executor with fictional Rust IPC. No real customer data is used.

The browser finish review found a clipped code at 320px/200% text and two undersized links. One correction batch resolved both, with a measured whole code and 48px links. A fresh reviewer/documenter could not be spawned because the agent thread limit had been reached; existing backend/Rust agents were reused and the substitution is documented. This bounded review does not certify accessibility, the native executable or the entire ERP.

**Rust execution limitation:** `cargo check --lib --offline` was attempted. Windows application control refused dependency build executables with OS error 4551 before the application crate was compiled. Cargo metadata and selected rustfmt/diff checks ran; the new Rust tests are written but have not run. No Windows protection was bypassed, no compiler success or native release is claimed.

## Proposed migration, activation and rollback

This milestone proposes only D1 migration 0088. Existing Supabase migrations are preserved; PostgreSQL company, ERP and RLS structures are reused. All new SQL was exercised locally, including actual workerd D1 atomic pairing/rollback. No production or staging migration has been run by this milestone.

`INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED` defaults closed and additionally requires the core and US ERP flags. Closing the new flag prevents admission/use while retaining the ability to revoke the matching known credential. Rollback is to keep the flag closed and retain the additive records; do not delete customers, accounts, books or session history. A native rollback preserves CH storage and licence. Do not install an older native build over an active US pilot without a recovery plan for its selected-edition metadata.

Production activation requires explicit approval, the additive migration on staging first, verified hosted Auth/PostgreSQL/D1 authority, a tested USD offer/catalogue/evidence configuration, and a successful signed/runnable native build with two real installations. Those are release gates, not local test results.

## Remaining work and risks

Native purchases/vendor invoice workflows, protected PDF/CSV exports, US seller/tax settings, banking/reconciliation screens and international Support/Automation integration remain subsequent slices. No production tax provider, arbitrary USD prices, real financial issuance, certification or guaranteed legal compliance is activated here. US payroll, original-document uploads and offline US financial writes are outside this admission milestone.

The source changes cross server authorization and native protected storage. A passing frontend preview cannot prove native persistence, physical-device behavior, durable crash recovery or hosted multi-device isolation. Historical dependency/security findings are not resolved or certified clean by this lot. Real tax, accounting and privacy decisions still require the applicable professional review from the audit.

## Files

Created and modified files for each checkout are listed separately in the machine-readable companion, with base commits and content hashes. The source contract is `US-NATIVE-ADMISSION-CONTRACT-20261008.md`; the previous audited plan is `NATIVE-US-ADMISSION-PLAN-20261008.md`; native shared source provenance is `NATIVE-SHARED-DOMAIN-MANIFEST-20261008.json` in the isolated native checkout. The protected native and CH corrections checkouts were checked unchanged at this milestone.
