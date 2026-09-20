# Fichiers de Zentra Automation

Inventaire des changements fonctionnels. Le site et le logiciel natif utilisent deux branches distinctes.

## Site et services

Branche : codex/support-jev-20260919.

- `app/api/account/claim/route.ts`
- `app/api/automation/admin/route.ts`
- `app/api/automation/billing/route.ts`
- `app/api/automation/route.ts`
- `app/api/referrals/route.ts`
- `app/api/stripe/checkout/route.ts`
- `app/api/stripe/license/route.ts`
- `app/api/stripe/webhook/route.ts`
- `app/automation/conditions/page.tsx`
- `app/automation/page.tsx`
- `app/automation/presentation.css`
- `app/compte/automation/page.tsx`
- `app/compte/page.tsx`
- `app/conditions/page.tsx`
- `app/confidentialite/page.tsx`
- `app/page.tsx`
- `app/parrainage/conditions/page.tsx`
- `app/pricing/page.tsx`
- `app/produits/page.tsx`
- `app/sitemap.ts`
- `components/automation/automation.css`
- `components/automation/company-settings.tsx`
- `components/automation/founder-settings.tsx`
- `components/automation/labels.ts`
- `components/automation/referral-panel.tsx`
- `components/purchase-button.tsx`
- `components/site-footer.tsx`
- `db/automation-schema.ts`
- `db/schema.ts`
- `docs/AUTOMATION-DEMARRAGE.md`
- `docs/ZENTRA-AUTOMATION.md`
- `drizzle/0047_zentra_automation.sql`
- `drizzle/0048_automation_checkout_guard.sql`
- `drizzle/0049_referral_reward_invoice.sql`
- `drizzle/0050_automation_checkout_retry.sql`
- `drizzle/meta/0047_snapshot.json`
- `drizzle/meta/0048_snapshot.json`
- `drizzle/meta/0049_snapshot.json`
- `drizzle/meta/0050_snapshot.json`
- `drizzle/meta/_journal.json`
- `lib/automation/access.ts`
- `lib/automation/billing.test.ts`
- `lib/automation/billing.ts`
- `lib/automation/checkout.test.ts`
- `lib/automation/config.ts`
- `lib/automation/policies.ts`
- `lib/automation/provider.test.ts`
- `lib/automation/provider.ts`
- `lib/automation/resources.ts`
- `lib/automation/sanitize.ts`
- `lib/automation/service.test.ts`
- `lib/automation/service.ts`
- `lib/automation/transport.ts`
- `lib/automation/types.ts`
- `lib/checkout-legal.test.ts`
- `lib/downloads.ts`
- `lib/license-token.ts`
- `lib/plans.ts`
- `lib/referrals.test.ts`
- `lib/referrals.ts`
- `lib/stripe-checkout.ts`
- `lib/stripe-contract.test.ts`
- `lib/stripe-event.ts`
- `lib/stripe.ts`
- `lib/support/jev.ts`
- `app/telecharger/page.tsx`
- `docs/AUTOMATION-FICHIERS.md`
- `docs/RELEASE-1.72.0.md`

## Application Windows, Mac, iPhone et Android

Source des binaires : 986f9f3bfec881362c7256942fa4cb27edf51fe5, branche codex/automation-native-20260920.

- `desktop/package.json`
- `desktop/src-tauri/Cargo.lock`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/src/account_cloud.rs`
- `desktop/src-tauri/src/automation.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/AssistantAutomationAction.tsx`
- `desktop/src/AutomationCatalogMapping.tsx`
- `desktop/src/AutomationControls.css`
- `desktop/src/AutomationControls.tsx`
- `desktop/src/AutomationDocument.tsx`
- `desktop/src/BankScreen.tsx`
- `desktop/src/CatalogImportWizard.tsx`
- `desktop/src/Onboarding.tsx`
- `desktop/src/ProjectFilesPicker.tsx`
- `desktop/src/SupplierEmailIntake.tsx`
- `desktop/src/SupplierInvoiceWizard.tsx`
- `desktop/src/WorkspaceApp.tsx`
- `desktop/src/ZentraAssistant.tsx`
- `desktop/src/appReleaseNotes.ts`
- `desktop/src/automation.test.ts`
- `desktop/src/automation.ts`
- `desktop/src/catalogImport.ts`
- `desktop/src/dark.generated.css`
- `desktop/src/translations.ts`
- `desktop/src/translationsAutomation.ts`
- `desktop/tests/automation-harness.html`
- `desktop/tests/automation-harness.tsx`
- `docs/ZENTRA-AUTOMATION.md`
