# US tax invoice — observed TEST vertical

8 October2026, web base47bd26388d15472742a4bf4b2a7ecb072ea933c6 and native base3e35b81ea17b33e46108c7b299a78b100118d4d5. Incremental continuation, not commercial completion. No live price, registration, subscription, CH code, country migration or production flag change is authorized by this phase.

## End-to-end requirement

An accepted estimate must become a real provider-calculated TEST invoice, journal and Letter PDF through the same admitted US book. A provider mock is unit-test evidence only. A real Stripe sandbox calculation is provider evidence only; it does not establish legal tax applicability, hosted Auth/storage, native compilation or production readiness. The full US objective also retains goods, credits/refunds, payment/banking, subscriptions, international Support/Automation and deployment validation; a first services-only vertical does not replace that scope.

The current runtime has no installed tax gateway/hook. The native pilot now reads a protected, volatile readiness projection; the default server has no evaluator and cannot return `ready_test`. A successful informational response is not sufficient to install the issuer: the mutation route must independently enforce the requisite observed provider context. Customer input, tax facts, hash strings, header versions and readiness responses do not confer financial authority. `allowTestFixtures:false` remains mandatory for an observed provider path.

## Existing corrections before connection

- Reproduce and normalize `ACCOUNTING_PERIOD_CLOSED` to the existing controlled `accounting_period_closed/409` in the private issuer, preserving exact historical replay and fresh authorization.
- Reproduce actual PostgreSQL fiscal commit/replay for schema4; introduce an additive versioned capability fence before both new commit and historical receipt return. Do not alter an old migration.
- New RPC `zentra_commit_us_tax_invoice_test_v2` takes the existing8 arguments plus `p_supported_schema_version`. Its server-only port receives the same trusted ceiling as the ERP store. The factory defaults explicitly to1; older schema3 test ports must provide3 explicitly.
- The historical RPC becomes an additive wrapper with an explicit maximum3, retaining existing1–3 behavior and refusing4. A numeric body/header is never substituted for a captured credential/server ceiling. Functions remain invoker, empty search path, private service-only grants and existing RLS/transaction/financial proofs.
- Normalize `PU008` to `client_upgrade_required/409`. The PostgreSQL transaction owns atomic head/record/audit/event/receipt and proof correlation. Exact committed replay avoids a second provider call, but still requires current US authorization and an adequate versioned reader.
- Historical replay after promotion uses the original schema from the immutable same-organization ERP event correlated to the exact receipt. Receipts have no schema-version field. The current head still requires the captured ceiling; a forged lower header cannot replay an original schema4 invoice, and the legacy ceiling3 cannot read a current schema4 book.

## Real provider boundary

Use a separate sandbox; never the Zentra SaaS live account as a fallback merchant. Credentials remain in the CLI-owned private profile or protected server secret resolver, outside source and logs. Fixed SDK/API version, authenticated account and TEST mode, actual Tax Settings and registrations, confirmed catalogue classifications and origin/customer address precede calculation. A key prefix or SDK response metadata alone does not prove those facts.

Verification rereads and compares current provider settings/registrations with the saved binding; it must not silently rewrite binding revision/observedAt during a reserved operation. Request parameters, provider key, estimate and country/seller/tax revisions remain frozen and scoped. No new key after an ambiguous result; retry windows and expiry stay explicit. No rate/code is guessed to obtain a positive tax amount. Tax date is explicitly resolved from the invoice date and the seller zone.

## Readiness contract and native integration

Readiness is volatile information, not a grant: `{schemaVersion:1, organizationId, currency:'USD', effectiveSchemaVersion:1|2|3|4, checkedAt, expiresAt, status:'ready_test'}` or the same with `status:'blocked'` and one bounded reason. Instants are server UTC seconds, bounded lifetime. No EIN, private address/fact/revision, Stripe account, hash, provider name, key, bearer or proof is exposed.

Reasons: `financial_role_required`, `workspace_uninitialized`, `country_configuration_required`, `configuration_outdated`, `seller_configuration_required`, `tax_details_required`, `provider_test_unavailable`, `provider_observation_expired`, `scope_not_supported`. Financial read roles receive only the blocked projection without owner-private reads. Effective capability is bounded by the actual credential/server and actual book; capability4 itself is not a fiscal grant.

Native port `read_us_tax_readiness(expectedWorkspaceScope,expectedMemberContextNonce)` captures the existing protected US admission. It uses the fixed organization route, JSON body<=4096 bytes, HTTPS/no redirects/no-store, strict exact fields, bounded expiry and capability, and verifies the same stamp after success/error. No secret or alternative financial credential is introduced. Server POST independently repeats all required authorization/configuration/provider checks.

The invoice editor survives readiness expiry; only review becomes stale and confirm is disabled. Recheck on open/review/focus rather than polling owner-private data every3 seconds. Keep pending exact request/key/dates/id/body independent of readiness so a historical receipt remains recoverable. Identity/role/nonce loss purges. Action and result explicitly identify TEST. Net review is not described as a tax-inclusive pre-calculation; tax/total appear in the final provider-validated invoice.

## Evidence to deliver

Baseline failure and corrected tests; actual local PG migration chain through schema4 and new capability fence; old RPC1–3 replay and cap1/3 refusal for head4; cash/accrual posting, periods, changed/expired provider context, response loss and same-key retry, authorization loss; real sandbox provider observation when available; protected readiness and stable editor/retry tests; TS/lint/build and source-only/native limits stated separately. Preserve the published public-site branch. No staging/production migration, US tariff, live tax registration or real payment without the explicit approval required in the original mission.
