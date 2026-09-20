# Zentra Automation — implementation and verification

French operating guide: [AUTOMATION-DEMARRAGE.md](AUTOMATION-DEMARRAGE.md). Complete changed-file inventory: [AUTOMATION-FICHIERS.md](AUTOMATION-FICHIERS.md).

## Architecture inspected (20 September 2026)

- Public site and account: React 19 / Vinext, Cloudflare Worker, D1 migrations via Drizzle, R2 documents. Supabase supplies verified account identity. Organization membership and device sessions are enforced by `lib/account.ts`; subscription ownership is separate from membership.
- Billing: Stripe API `2026-08-26.dahlia`, verified webhook, paid invoice entitlements. Support has separate subscriptions and must stay separate from the Gestion add-on.
- Native app: React/Vite + Tauri 2 / Rust + local SQLite, Windows/macOS/iOS/Android. Current native release source is the clean `zentra-quality-20260912` worktree (1.71.1); the website's embedded desktop folder is old (1.46.1). Do not release that older folder.
- Company sync: current native 1.71.1 uses private whole-database/archive revisions on Supabase; the website also contains the newer validated D1/R2 snapshot/transaction service. Automation does not replace either. Native Rust reads candidates from the currently bound local SQLite database, discards WebView-supplied candidates, and validates returned IDs again. Its authenticated device request sends this bounded projection, without opening another company database. Browser decisions use committed organization-scoped D1 snapshots. A client-supplied organization ID never grants access to another company.
- Existing local assistant: Qwen/Wllama and OCR (Tesseract/PDF extraction). Retained for extraction and language understanding. Automation receives bounded text, not arbitrary raw document uploads.
- Existing TypeSafe adapter: `lib/support/jev.ts`, authenticated POST `/v1/systemone`. API key encrypted with AES-GCM on server. Customer-facing Automation naming is independent of provider.

## Implementation order and release gates

1. Central DecisionProvider, typed choices, timeouts/retry, minimal audit, private founder configuration, flags and shadow mode; test before enabling.
2. Bank and document suggestions integrated into existing native workflows; no automatic accounting changes.
3. Supplier/project candidates from authorized company data; assistant navigation only to allowed existing workflows, business commands retain their own permissions and confirmation.
4. Unusual-operation signals, deterministic deadline priority, optional email classification and editable import mappings.
5. Optional 15 CHF/month add-on, explicit Stripe checkout, entitlement only after verified payment. Founder settings use authenticated founder identity, never client-supplied email.
6. Company referral code: new paying company gets 50% on its first Gestion month; referrer gets 25% on its next Gestion monthly invoice after successful first payment. No self-referral, no duplicate awards, no automatic extra charges. Confirm financial scope in UI and terms.
7. Public presentation, account controls, native setup choice; verify mobile, accessibility, tests, typecheck/build, live checkout without making a payment, and published URLs.

## Provider references verified

- https://docs.typesafe.ai/api.md — Bearer authentication, `state`, `model`, `questions`, Choice response distribution/confidence, errors 429/529.
- https://docs.typesafe.ai/confidence.md — confidence differs from selected probability; thresholds depend on risk.
- https://docs.typesafe.ai/model-jaggedness/jev-1.13.md — numeric/date arithmetic and execution stay deterministic; sanitize untrusted content; retain manual fallback.

## Safety and operation

All modes produce proposals, never arbitrary tool execution. Shadow mode hides the suggestion until the real user decision is recorded. Only decision identifiers, option keys, result, confidence, usage and timing are audited; raw extracts and messages are not retained in audit. Resource candidate labels and minimal context are sanitized before leaving the server. High confidence permits preselection, not payment, posting, deletion, export, or permission changes.

Completion evidence, environment variables, migrations, feature flags, test commands and manual deployment requirements are recorded below as each phase is completed. This document is a work log, not a claim that unfinished capabilities are released.

## Delivered source layout

Web: `lib/automation/{types,transport,provider,sanitize,policies,resources,access,config,service,billing}.ts`; strict provider, service/tenancy and checkout tests alongside them. `lib/support/jev.ts` reuses the central HTTP transport while preserving Support's triage adapter. `lib/referrals.ts` and its tests handle company codes, qualification, coupons and rewards. Paid-invoice validation in `lib/stripe-event.ts`, `lib/stripe.ts`, `lib/license-token.ts` and account/license routes now recognizes only verified referral discounts. Stripe checkout/webhook, purchase button, account/product/pricing/footer/sitemap pages are integrated. `components/automation/*`, `/automation`, `/automation/conditions`, `/compte/automation`, `/parrainage/conditions`, `/api/automation`, `/api/automation/admin`, `/api/automation/billing` and `/api/referrals` provide the public and authenticated flows. Privacy/processing disclosures include Automation.

Native branch `codex/automation-native-20260920`: new `desktop/src-tauri/src/automation.rs`; registered commands and fixed account route in `account_cloud.rs`/`lib.rs`. New frontend `automation.ts`, `AutomationControls.tsx/.css`, `AutomationDocument.tsx`, `AutomationCatalogMapping.tsx`, `AssistantAutomationAction.tsx`, `translationsAutomation.ts`, tests and development-only `tests/automation-harness.*`. Integrations: `Onboarding`, `WorkspaceApp`, `BankScreen`, `ProjectFilesPicker`, `SupplierInvoiceWizard`, `SupplierEmailIntake`, `ZentraAssistant`, `CatalogImportWizard`, `catalogImport`, `translations`.

The onboarding option is voluntary, shown before creating the local workspace; Skip continues normal setup. Settings can reopen the online account. No subscription is started from the app itself. Bank suggestions are classifications recorded in the Automation audit, not accounting entries. Supplier and import suggestions fill editable drafts; only existing validated save/import actions commit business data. The assistant opens an allowed screen/form after confirmation; it does not generate or issue an invoice automatically. Existing email imports are classified; there is no background mailbox reader. Import mapping currently integrates the real catalogue CSV/XLSX workflow, not a new general-purpose migration engine. Document extraction uses the existing local PDF/OCR tooling (up to two pages and 1,800 characters).

## Configuration and migration

Existing required server bindings: `DB` (D1), `FILES` (R2), existing Supabase auth configuration. Server secrets/settings: `ZENTRA_OWNER_EMAIL` (verified founder email), `SUPPORT_ENCRYPTION_KEY` (existing AES-GCM key; do not rotate without re-encrypting the shared vault), `STRIPE_SECRET_KEY`, existing `STRIPE_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_ENDPOINT_ID`, `PUBLIC_SITE_URL=https://zentraapp.ch`. Optional fallback `TYPESAFE_API_KEY`; preferred configuration is the founder account, never a Vite/client environment variable.

Connect to TypeSafe's account dashboard, create/use its API key, then log in with the verified founder account on `/compte/automation` and use **Clé API TypeSafe Jev → Vérifier et enregistrer**. A synthetic verification precedes encrypted storage; failed replacement preserves the old key. **Vérifier le service** runs a fictitious materials classification through the actual Automation provider. No customer needs a provider key. The shared key powers Support and Automation.

Generated, additive D1 migrations: `0047_zentra_automation.sql`, `0048_automation_checkout_guard.sql`, `0049_referral_reward_invoice.sql`, `0050_automation_checkout_retry.sql` and matching Drizzle snapshots/journal. Use normal Sites deployment migration application; do not recreate the database or edit previously applied migrations. SQLite native schema is unchanged. D1 tests apply the complete migration chain to a fresh SQLite database.

In founder settings, **Préparer le tarif de 15 CHF/mois** verifies the Stripe account/webhook and creates or reuses the exact CHF 1,500-cent monthly product and portal configuration. It does not charge anyone. A company owner then accepts the add-on terms and data processing, completes Stripe Checkout, and is entitled only after a canonical paid invoice is verified. Owner-only checkout/portal, exact currency/amount/customer/price/mode validation, pending-session lease and stable idempotency parameters prevent duplicate subscriptions. A base Gestion subscription is required. No live purchase was made by these tests.

## Flags, shadow and audit

All global flags default OFF; company settings default disabled, mode `shadow`, medium threshold 0.65 and high 0.90. Founder **Fonctions disponibles** controls the global allowlist. An authorized owner/admin selects the corresponding company flags and consents: `transaction_classification`, `document_routing`, `supplier_routing`, `agent_routing`, `anomaly_detection`, `priority`, `email_classification`, `import_mapping`. Both levels and the entitlement must allow a feature before sending context.

For shadow: activate an entitled test company, choose **Observation**, select flags and save. Open a relevant workflow; the provider's proposal stays hidden until the user's independent choice is recorded. Compare accepted/corrected/rejected results in founder **Observation · 30 derniers jours**. This is agreement with human choices, not a guarantee of legal/accounting correctness. Use representative validated examples before enabling suggestions for clients. High confidence permits preselection only; medium suggests; low confidence requests a manual choice. Deadlines are computed by code and may raise a proposed priority. Unusual-operation signals never block banking or assert fraud.

`automation_decisions` records organization, actor, feature, option keys/authorized ID mappings, context hash (not raw text), provider/model, policy version, probabilities/confidence, minimal scalar usage, latency, state/error code and final human feedback. Only the authenticated author can evaluate their decision; metrics agreement is calculated server-side. Provider data is bounded and sanitized but free text is not claimed to be fully anonymized. Company state excludes raw bank identifiers; full files, keys and full conversations are not transmitted. Runtime failure keeps manual workflows usable; ambiguous network failures are not blindly retried. 60 decisions per minute per company, bounded response body and timeout limit abuse.

## Referrals

Owner/admin obtains a company code in `/compte/automation`. A new company enters it at the Gestion purchase step. It gets 50% off its first monthly Gestion invoice. The referrer earns one 25% reduction only after that first payment is verified. Rewards queue one per next monthly invoice; do not stack discounts or overwrite another existing discount. Applies to Gestion (not Support or Automation), one first-purchase benefit per new account/company, no self-referral. Coupon identity, exact percentage, product, claimant, invoice and subscription are validated before a discounted payment grants access. Duplicate webhooks and uncertain checkout responses reuse identities. Refund/dispute adjustments require operator review; no automatic clawback is advertised.

## Verification on 20 September 2026

- Full web suite, final rerun: 1,102 passed in 84 files, 63 pre-existing skips. The outdated legal-checkout fixture now includes the real unique session index. Browser and native-device entitlement parity is covered, including the founder account without a paid add-on.
- 14 referral tests and 58 existing Support tests pass with central transport. Invalid payloads, low confidence, timeouts, redirects, secret filtering, changed/foreign resources, stale requests, permissions, duplicate feedback, failed payment resumes, session expiry and missing consent are covered.
- Native frontend full suite: 1,558 tests in 187 files pass. Native TypeScript and production Vite build pass (existing large-chunk advisory).
- Rust check passes; all four new actual-SQLite Automation tests pass (723 other tests filtered). Existing dead-code warnings remain.
- New web files pass targeted oxlint; full-repository lint reports existing Support/device-team/legacy test errors unrelated to this feature. Web TypeScript and Sites production build pass.
- Mobile 320 px interactive fixture: category correction and editable column mapping produce a preview without committing data; no horizontal overflow. Four-language strings added. Live publication and native distribution evidence are recorded separately after they actually succeed.

## Production configuration verified

The presentation, account configuration, terms and referral pages were published on 20 September 2026. The founder's existing encrypted key passed a real synthetic operation using the Automation provider. The monthly CHF 15 Stripe product and price were verified through the founder settings without a purchase or charge. All eight global feature flags are available; company consent and enablement remain explicit. Founder administration does not silently grant a paid company add-on: browser and device sessions use the same organization entitlement.

The founder company can retrieve its referral code in the account. No real customer payment or real referral reward was fabricated. A company owner still completes Checkout personally and chooses the features to enable. The native changes are released as 1.72.0 from branch `codex/automation-native-20260920`; see the release evidence for the exact tested source and each platform's distribution limitations.

## Remaining operator steps

The client owner must complete any real subscription payment themselves. Production feature enablement needs an available TypeSafe balance and approved processing terms; no Swiss-only location, certification or zero-retention claim is made. Payment/referral simulations prove code behavior, not a real completed customer purchase. Install the newly built native version to see onboarding and in-app suggestions; older installed versions cannot gain a native screen from a website deployment. Platform signing/notarization/store distribution remain governed by the existing release pipeline and Apple enrollment.
