# Native international ERP gateway

This is an incremental branch of the existing Zentra app, based on `596a3f2ba1b65e2fe599a7996bd638d104a0d53d` / native version 1.90.15. It does not replace legacy Swiss data or introduce a second standalone app. The original gateway delivery below is followed by the experimental Settings pilot documented in [NATIVE-US-PILOT.md](NATIVE-US-PILOT.md). Neither delivery includes a local financial migration, production call, installer or release.

## Contract

- `read_international_erp(expectedWorkspaceScope, expectedMemberContextNonce)` reads `GET /api/international/workspaces/{organizationId}/erp`.
- `execute_international_erp(request, expectedWorkspaceScope, expectedMemberContextNonce)` posts `{idempotencyKey, expectedRevision, command}` to the same endpoint.
- The organization and bearer come exclusively from the protected native account session. Neither is an IPC parameter. The server supplies current membership, financial authority and subscription entitlement.
- GET returns `{status: 'ready', state: ErpState}` or `{status: 'uninitialized', configuration: CompanyConfiguration}`. POST returns `{receipt: ErpReceipt, replayed: boolean}`.
- Commands, money, dates and identifiers use the shared `lib/international/runtime-types.ts` contract. No submitted tax determination or role is accepted.
- `refresh_configuration` has no submitted configuration; only the server can load the confirmed workspace profile and authorize its refresh. An uninitialized response is configuration waiting for initialization, not an empty invented Swiss or US business. Idempotency keys accept at most 232 characters so payment-specific ledger prefixes remain within the financial contract.

Native requests require a matching installation, active session, company binding, original workspace scope and member nonce. A private stamp also captures session/pending/exchange protected references and their in-memory revisions. The account → local-store locks cover preflight and postflight only, never the HTTP future. Both successful and failed network results are discarded after any admission change, including a same-company credential rotation or member switch.

The endpoint constructor admits only one fixed HTTPS origin and one fixed ERP path pattern. Requests use pooled TLS with no redirects, no credentials in URLs or logs, a 30-second timeout, a 256-KiB request cap and an 8-MiB response cap. Server error bodies are not echoed. POST is never retried automatically. On uncertainty, the caller must retain its immutable request and stable key for reconciliation or an explicit retry.

The frontend gateway validates exact outer shapes, scoped records, safe revisions, canonical integer amount strings, currency/basis consistency and receipt keys/actions/hash syntax. These checks do not replace authoritative server validation or atomic financial commits. State pagination is a later scalability requirement; oversized responses fail explicitly instead of silently truncating records.

## Executed validation (8 October 2026)

| Check | Result | Scope |
| --- | --- | --- |
| Rust `cargo +stable-x86_64-pc-windows-gnu test --lib international_erp --locked --offline` | 11 passed; 1,226 filtered before the final refresh/key-cap extensions | Real temporary SQLite profiles, protected session/cache guards and member context; HTTP future synthetic, no network |
| Final Rust recompile after `refresh_configuration` / 232-character key cap | Compilation passed; test execution blocked by Windows App Control, OS error 4551 | The final protocol extensions still require a native runner that permits this test binary; no protection was bypassed |
| Frontend `vitest run src/internationalErp.test.ts src/workspaceMemberOrigin.test.ts --config vite.config.ts` | 39 passed (14 new / 25 existing) | Request immutability, no retry, exact protocol, configuration refresh, origin recovery, canonical amounts and scope isolation |
| Desktop TypeScript `tsc --noEmit --project desktop/tsconfig.json` | Passed | Full desktop source and imported shared contracts |
| Desktop `vite build` | Passed | Production frontend; existing >500-KiB chunk warnings remain |
| `git diff --check` | Passed | Source whitespace |

No end-to-end live server, RLS, tax provider, subscription, multi-device or physical-device behavior was tested by this original gateway delivery. The later pilot adds the Settings flow and incremental reads; its current executed validation supersedes the earlier test-run blockage above. Company-specific onboarding and the complete US ERP rollout remain pending without rewriting Swiss historical financial books.
