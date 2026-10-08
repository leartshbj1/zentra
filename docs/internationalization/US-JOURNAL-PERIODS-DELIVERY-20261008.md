# Zentra US — livraison journal et périodes

8 octobre 2026. Phase incrémentale locale, sources isolées ; aucun déploiement US, prix USD, clé, abonnement, donnée métier ou migration de production modifiés. Le nouveau menu public est un lot indépendant déjà publié en version355.

## Modifications et résultat

Le même livre ERP US prend en charge les écritures manuelles équilibrées, leur contrepassation liée et les périodes comptables. Les montants sont des chaînes de centimes exacts ; les comptes de contrôle clients/fournisseurs/taxes/acomptes sont exclus des écritures manuelles. L’ouverture ajoute une période future ; une clôture nouvelle concerne la plus ancienne période ouverte. Aucun original validé n’est supprimé.

Le propriétaire doit confirmer explicitement l’adoption3→4. Pour le client natif, la session doit avoir capturé une capacité4 ; aucun en-tête ou ancien credential3 ne donne ce droit. Les brouillons résistent à une révision extérieure, mais la confirmation devient périmée. Une réponse perdue après commit conserve la requête et la clé exactes pour éviter le doublon. Les autorisations et le contexte sont relus ; une perte d’accès purge l’interface.

L’interface existe dans les quatre langues, avec journal/périodes/rapports et confirmation avant action. Les rapports PDF Letter, CSV et JSON réutilisent les mêmes données comptables exactes. La sélection d’onglet conserve un contraste mesuré de7.04:1 minimum dans les24 configurations locales. Cela ne constitue pas une certification d’accessibilité complète.

## Migrations proposées

- `drizzle/0089_international_us_device_capability_v4.sql` : famille additive de nouveaux challenges/sessions4 ; aucune réécriture des identifiants1–3.
- `supabase/migrations/20261008161118_international_us_journal_periods_v4.sql` : même livre privé, RPC4 et contraintes journaux/périodes, CAS, audits et reçus corrélés, RLS et privilèges conservés.

Création PG par Supabase CLI2.119.0. Historique des migrations conservé. Les deux migrations ont été testées localement, jamais appliquées au staging hébergé ou à la production. La migration D1 doit précéder les nouveaux handlers qui lisent les deux familles. Retour arrière : fermer les gates4, arrêter les nouvelles mutations, conserver livres/sessions/reçus/événements ; ne pas rétrograder un livre4 ni effacer ses écritures.

## Tests réellement exécutés

| Périmètre | Résultat final | Limite |
| --- | --- | --- |
| Web/domaine/HTTP/SQL/D1/transports/rapports |28 fichiers,770/770 tests,0 skip | RAM PGlite sérialisée, local workerd ; Auth/abonnements fictifs |
| Web TypeScript, lint syntaxique, build Vinext et diff check | Exit0 ; 45 fichiers lint | Lint typé bloqué par Windows, non annoncé réussi |
| Web navigateur réel |24 configurations sans débordement/erreur ; workflow journal→réponse perdue/retry→clôture→contrepassation/purge | HTTP/core réels avec CAS RAM fictif |
| Native frontend/transport/domaine |18 fichiers,146/146 tests,0 skip ; TS/Vite/syntax lint/Rustfmt/diff check0 | Pas de binaire Rust ; Vite avertit de chunks existants>500kB |
| Native revue navigateur |18 captures,4 langues, clair/sombre,1440/390/320 et texte200% ; parcours fonctionnel repassé | Ports Rust simulés ; timeout de sélecteur initial conservé |
| Rust |69 tests déclarés dans les deux suites ;0 compilé,0 exécuté | Cargo non lancé ; blocage Windows précédent, aucun contournement |

Après les146 tests produit, la référence du gel a été rendue durable et versionnée, sans changement des règles/UI/Rust/corpus financier. Trois fichiers de contrôle complémentaire (13 tests) puis TypeScript et lint syntaxique sur2 fichiers passent séparément ; ces13 ne sont pas additionnés aux146. La copie historique `docs/evidence/us-journal-domain-source-freeze-20261008.json` conserve ses bytes/SHA exacts dans les deux repos, avec un attribut Git -text ciblé. Le gel final exclut les deux documents communs pour éviter une référence circulaire.

Les105 tests de stockage et les sous-lots de domaine sont inclus dans les770 : aucun total artificiel par addition. Les passes intermédiaires en échec sont conservées séparément. Chaque inventaire, hash de source et preuve est référencé dans `docs/evidence/us-journal-periods-20261008.json` ; les journaux et captures locaux sont dans `.qa/us-journal-periods/` (web) et `desktop/.impeccable/review/native-us-accounting/` (native).

## Compatibilité suisse et isolation

Le seul changement du module comptable partagé CH est l’élargissement du type d’action d’audit pour `period_opened` ; aucune fonction CH modifiée. La CSSCH reste SHA256 `424c7ee66d05af6c43ecd169f3ea2bdd4d0b8e9250a83462b73f330ebd41197f`. Les branches de startup CH et les wrappers Rust historiques restent protégés ; les nouveaux ports ne donnent pas de droit CHF. Aucune migration historique, donnée ou ancienne sauvegarde n’a été effacée. Les clones publiés et sources anciennes n’ont pas reçu ce lot US.

## Risques et reste à faire

Ce lot n’est ni un ERP US commercial complet ni une conformité USGAAP. Il reste notamment l’observation d’un fournisseur fiscal TEST réel, les classifications/registrations et règles applicables validées professionnellement, le cycle facture fiscal complet, un catalogueUSD approuvé, les paiements/banking et workflows Support/Automation US à valider dans le contexte admis. Les tests hébergés multi-appareils/concurrence/reconnexion/backup et une compilation Rust exécutée sont requis avant distribution.

La prochaine verticale est `executeUsTaxInvoiceTest` depuis un devis accepté jusqu’à facture, journal et PDF avec preuve réelle du fournisseur TEST et stockage durable de staging. `taxProvider:null` et l’émission native fermée restent des protections effectives ; un formulaire renseigné ou un simple booléen ne remplace pas ces preuves. Les gates restent fermés par défaut. Toute modification de production nécessite l’approbation explicite prévue dans la demande.

## Fichiers Web

Base : `90d131646a352e149c03b80b9260ec8eda724a2d`.

### Créés

- `.gitattributes`
- `components/account/us-erp-accounting.css`
- `components/account/us-erp-accounting.tsx`
- `docs/evidence/us-journal-domain-source-freeze-20261008.json`
- `docs/evidence/us-journal-periods-20261008.json`
- `docs/internationalization/NATIVE-US-JOURNAL-PERIODS-DELIVERY-20261008.md`
- `docs/internationalization/US-JOURNAL-PERIODS-CONTRACT-20261008.md`
- `docs/internationalization/US-JOURNAL-PERIODS-DELIVERY-20261008.md`
- `docs/internationalization/US-JOURNAL-PERIODS-STORAGE-EVIDENCE-20261008.md`
- `drizzle/0089_international_us_device_capability_v4.sql`
- `lib/international/accounting-exports.test.ts`
- `lib/international/accounting-runtime.test.ts`
- `lib/international/accounting/us-journal.test.ts`
- `lib/international/accounting/us-journal.ts`
- `lib/international/browser-accounting-copy.ts`
- `lib/international/browser-accounting.browser.test.ts`
- `lib/international/browser-accounting.test.ts`
- `lib/international/browser-accounting.ts`
- `lib/international/journal-periods.postgres.test.ts`
- `lib/international/us-device-capability-v4.test.ts`
- `supabase/migrations/20261008161118_international_us_journal_periods_v4.sql`

### Modifiés

- `components/account/us-erp-reports.tsx`
- `components/account/us-erp-workbench.tsx`
- `lib/international/accounting/ledger.ts`
- `lib/international/browser-erp-session.ts`
- `lib/international/browser-export-session.ts`
- `lib/international/browser-projects.ts`
- `lib/international/erp-request.ts`
- `lib/international/erp-schema-capability.ts`
- `lib/international/export-bindings.ts`
- `lib/international/export-server.test.ts`
- `lib/international/export-server.ts`
- `lib/international/export-snapshot.ts`
- `lib/international/exports.postgres.test.ts`
- `lib/international/projects-transport.test.ts`
- `lib/international/projects.postgres.test.ts`
- `lib/international/purchasing-transport.test.ts`
- `lib/international/runtime-bindings.test.ts`
- `lib/international/runtime-bindings.ts`
- `lib/international/runtime-postgres.test.ts`
- `lib/international/runtime-server.test.ts`
- `lib/international/runtime-server.ts`
- `lib/international/runtime-store.ts`
- `lib/international/runtime-sync-store.ts`
- `lib/international/runtime-sync.ts`
- `lib/international/runtime-types.ts`
- `lib/international/runtime-validation.ts`
- `lib/international/runtime.ts`
- `lib/international/us-device-bindings.test.ts`
- `lib/international/us-device-bindings.ts`
- `lib/international/us-device-contract.ts`
- `lib/international/us-device-d1.ts`
- `lib/international/us-device-server.ts`
- `lib/international/us-device-test-fixture.ts`
- `lib/international/us-device-workerd.test.ts`

## Fichiers Native

Base : `59d1c771a00b1c8502ab270c187222d42e390c11`.

### Créés

- `desktop/src/NativeUsAccounting.test.tsx`
- `desktop/src/NativeUsAccounting.tsx`
- `desktop/src/nativeUsAccountingBoundary.test.ts`
- `desktop/src/nativeUsAccountingForms.test.ts`
- `desktop/src/nativeUsAccountingForms.ts`
- `desktop/src/nativeUsAccountingSession.test.ts`
- `desktop/src/translationsNativeUsAccounting.ts`
- `desktop/tests/native-us-accounting-review.mjs`
- `docs/evidence/us-journal-domain-source-freeze-20261008.json`
- `docs/evidence/us-journal-periods-20261008.json`
- `docs/internationalization/NATIVE-US-JOURNAL-PERIODS-DELIVERY-20261008.md`
- `docs/internationalization/US-JOURNAL-PERIODS-CONTRACT-20261008.md`
- `docs/internationalization/US-JOURNAL-PERIODS-DELIVERY-20261008.md`
- `docs/internationalization/US-JOURNAL-PERIODS-STORAGE-EVIDENCE-20261008.md`
- `lib/international/accounting/us-journal.ts`

### Modifiés

- `.gitattributes`
- `desktop/scripts/align-international-domain.mjs`
- `desktop/src-tauri/src/international_erp.rs`
- `desktop/src-tauri/src/us_admission.rs`
- `desktop/src-tauri/src/us_admission_tests.rs`
- `desktop/src-tauri/src/us_exports.rs`
- `desktop/src-tauri/src/us_exports_tests.rs`
- `desktop/src-tauri/tests/fixtures/us-native-domain-vectors.json`
- `desktop/src-tauri/tests/fixtures/us-native-domain-vectors.manifest.json`
- `desktop/src/InternationalErpPilot.test.tsx`
- `desktop/src/InternationalErpPilot.tsx`
- `desktop/src/NativeAdmissionRoot.tsx`
- `desktop/src/internationalErp.ts`
- `desktop/src/nativeAdmission.test.ts`
- `desktop/src/nativeAdmission.ts`
- `desktop/src/nativeSharedDomain.test.ts`
- `desktop/src/nativeUsCopy.test.ts`
- `desktop/src/translationsNativeUs.ts`
- `desktop/tests/generate-native-us-corpus.test.ts`
- `desktop/tests/native-us-admission-preview.tsx`
- `desktop/tests/native-us-fixture.ts`
- `docs/internationalization/NATIVE-SHARED-DOMAIN-MANIFEST-20261008.json`
- `lib/international/accounting/ledger.ts`
- `lib/international/erp-request.ts`
- `lib/international/erp-schema-capability.ts`
- `lib/international/runtime-sync.ts`
- `lib/international/runtime-types.ts`
- `lib/international/runtime-validation.ts`
- `lib/international/runtime.ts`
