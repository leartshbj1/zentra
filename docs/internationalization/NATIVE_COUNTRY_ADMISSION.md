# Native workspace country admission — local incremental implementation

Date: 2026-10-08. Site checkpoint before this tranche: `0bd4ef05254f16a5623cf227d083670aa3d357a2`.

## Scope and authorization

The existing `GET` / `PUT /api/international/workspaces/:organizationId/country` now admits either a browser session or a native device session. An `Authorization` header selects only `requireDeviceSession`; rejected, expired, revoked, malformed or foreign device credentials never fall back to browser cookies. A device session is bound to its exact enterprise; selecting a different enterprise still requires the existing account/device authorization process, not changing this request path.

Browser writes retain the existing same-origin CSRF check. Native writes carry the existing opaque device Bearer capability and do not require a browser `Origin`. The native gateway must not attach a browser account identity as an alternative to failed native authentication.

Both modes require fresh membership/seat authority and effective Gestion access from `teamSeats`. Country reads allow an active member; writes require the owner alone. The server ignores no authority claim from client JSON: unknown request fields are rejected. The account lookup uses `offerAccess: false`, so reading country configuration cannot implicitly claim an offered entitlement. Read/write rate counters have separate operation scopes and exact enterprise/user subjects (3,600 reads/hour, 120 writes/hour, with the existing IP dimension).

GET rechecks account/device identity, role, scope and Gestion access after storage awaits, before exposing the result. PUT validates the body, reads the current scoped country state, awaits any initial-US admission, rereads that state, then rechecks authority immediately before the existing CAS/idempotent PostgreSQL RPC. It rejects an intervening country change. The RPC still decides `expectedRevision` and exact durable retries; an earlier exact receipt remains valid after newer configuration writes.

The device recheck compares user, session, installation and subscription identities. Browser account session policy and membership/seat authority are queried afresh. These pre-RPC checks reduce stale authorization exposure; D1 authorization and PostgreSQL writes remain separate databases, so this is **not** proof of atomic cross-database revocation. PostgreSQL country CAS remains the final configuration-write concurrency guard.

## US onboarding remains gated

`INTERNATIONAL_CORE_ENABLED` still defaults to false and no production binding is changed here. Neither account language, a cookie, active subscription nor an absent country row can activate US automatically. An unconfigured/unknown workspace remains a legacy state requiring explicit review; no CH archive is imported or converted.

The first US country write requires the dedicated server attestation port. Its production implementation always refuses with `409 legacy_review_required`. Only local fictitious tests inject admission. A real implementation must attest an explicitly newly-created US organization with no CH history and a lock shared with legacy writes. No client boolean, public bypass, new migration or invented attestation is supplied in this tranche. Existing configured country edits remain subject to the existing jurisdiction lock and CAS RPC.

EIN is optional and remains private in the validated/stored configuration. GET and PUT responses use the shared public projection without EIN. For a US update that omits EIN, the service preserves the EIN from the immutable, exact enterprise/`expectedRevision` history row, rather than the current head. Therefore updating a language/address from a public view cannot erase the stored identifier, and replaying an earlier request remains stable after later private changes. A missing historical baseline is an explicit revision conflict; no current-state or CH fallback is used. An initial revision-zero request invents no EIN. An explicitly supplied valid EIN remains explicit input; omission is not a private identifier deletion operation. This tranche supplies no deletion command.

The internal `beforeWrite` callback revalidates admission after the historical baseline read and immediately before the RPC; authentication errors keep their status and are not mistaken for storage errors. This callback is server-only, never client JSON.

## Verification limits

Dedicated tests exercise HTTP handlers and production binding adapters with synthetic account/team-seat/Supabase ports, including browser CSRF, native scope, all roles, revoked membership/seat/session, expired Gestion access, waits, rate limits, changed configuration, idempotent replay and closed first-US admission. They are not physical Windows/macOS/iOS/Android, live D1/PostgREST, multi-device, or production onboarding evidence. No new database migration, provider, Stripe modification, data migration or production activation is part of this tranche.

Final local verification (2026-10-08, Europe/Zurich): **125/125 passed, zero failures and zero skips** in five files: country HTTP regression 18, native boundary 43, production adapter bindings 18, service 36, actual PostgreSQL WASM service/HTTP integration 10. The last group uses the existing versioned country migration and `SET LOCAL ROLE service_role`, not mocked SQL. It verifies preservation and old-receipt replay after a later EIN change, uncertain response retry, missing baseline, post-SQL native revocation, public projection, immutable history, and `anon` / `authenticated` refusals. It still uses synthetic account authority and a single local in-memory database connection; this is not live Supabase or concurrent-connection certification.

The consolidated Vitest JSON report is `D:/Codex-Zentra-Temporary/2026-10-08/native-country-tests-20261008.json`, started `2026-10-07T23:31:17.083Z` (2026-10-08 local). SHA-256: `6ed6364227ec764137764f2a90c568fd6668628d31c8861ea30a4d57c8b7f318`. Global `tsc --noEmit --pretty false`, lint of the seven country implementation/test files, and the tracked-file whitespace diff check exited 0 after the final source changes. No claim of a new production build, device installation or published release is made by this tranche.

Files: `lib/international/workspace-server.ts`, `workspace-service.ts`, their existing regression tests, `workspace-server.native.test.ts`, `workspace-server.bindings.test.ts`, `workspace-service.postgres.test.ts`, and this note. The shared `public-projection.ts` is maintained by the root tranche; `runtime-bindings.ts` is unchanged here.
