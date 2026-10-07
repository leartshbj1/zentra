# Application native courante — intégration internationale

Date : 8 octobre 2026. Audit statique en lecture seule, sauf ce document. Aucun appel de production, test, build, migration, création de compte ou modification de donnée métier n'a été réalisé par cet audit.

## Source autoritaire vérifiée

- Application à adapter : `D:/Codex-Zentra-Temporary/2026-10-04/quality-followup/app-integrated`.
- Branche : `codex/release-1.90.15-20261006`.
- Révision : `596a3f2ba1b65e2fe599a7996bd638d104a0d53d`, arbre propre au début de la lecture.
- Version Cargo : `1.90.15`. Schéma SQLite : **61**, déclaré dans `desktop/src-tauri/src/schema.rs:1`.
- Socle international examiné séparément : `C:/Users/alb/Documents/ChatGPT/chantier/lib/international`, et `desktop/tests/international-erp-pilot.tsx` dans ce même checkout.

Le premier audit desktop international porte sur un autre checkout (ancienne application 1.46.1, schéma 67, contrat `business_sync`). **Il ne décrit pas l'application native actuelle.** Dans l'application actuelle, `business_sync.rs` n'existe pas ; le transport d'entreprise utilise les archives vérifiées, le contenu découpé et la fusion à trois branches. Ne pas copier en bloc les anciennes migrations, les anciens modèles ou les anciens fichiers de comptabilité.

## Conclusion

Le chemin direct vers un ERP US consiste à ajouter la configuration nationale durable et les adaptateurs de juridiction au runtime actuel, puis à adapter ses transactions commerciales, écritures et PDF. Le pilote TypeScript isolé est une bonne spécification testable, mais il n'est connecté à aucune commande Tauri, base locale, synchronisation ou licence native. Aucun `InternationalCompanySetup` ou consommateur `lib/international` n'a été trouvé dans le frontend natif courant.

Il faut réutiliser les menus et protections actuels, pas remplacer les écrans par le pilote et lui donner le statut de produit. Les changements financiers doivent rester décidés par le backend Rust, avec des contrats équivalents aux fonctions pures TypeScript.

## Points d'intégration vérifiés

Tous les chemins de cette section sont relatifs au checkout natif courant.

| Contrat | Source actuelle / blocage | Intégration nécessaire |
| --- | --- | --- |
| Entreprise | `desktop/src/types.ts:33` Organization possède pays d'adresse, IDE/TVA ; `:46` BillingSettings fixe `currency: 'CHF'`. `AppSettings` n'a pas de juridiction comptable, fuseau métier, EIN ni statut de validation nationale. | Configuration liée à l'espace/entreprise, typée, versionnée ; absence = inconnu avec compatibilité existante, jamais inférence US depuis langue/adresse. Définir l'identité locale avant liaison cloud. |
| Lecture/écriture paramètres | `desktop/src/bridge.ts:1307` restitue CHF même si la ligne stockée porte une autre devise ; `:3251` réécrit CHF. `settingsToBackend`, `backendExtra`, `settingsFromRaw`, `normalizeWorkspace` sont les frontières. | Lire et écrire la configuration validée sans la perdre dans `extra_settings_json`. L'adaptateur de normalisation doit préserver les profils inconnus, refuser les valeurs corrompues, et inclure la région dans le cache de formatage. |
| Onboarding | `desktop/src/onboardingDraft.ts`, `onboardingValidation.ts`, `Onboarding.tsx` sont CH. `desktop/src-tauri/src/models.rs:35` OnboardingInput exige NOGA ; `database.rs:1195` valide le profil suisse. | Parcours commun avec adaptateur national et validation native équivalente : état US, ZIP, EIN facultatif, USD, fuseau explicite, méthode comptable. Ne pas sauver un faux NOGA pour contourner le contrôle. |
| Rôles et origine | `desktop/src-tauri/src/commands.rs:1963` `run_member_scoped_local_operation` garde le verrou, vérifie espace + nonce membre avant transaction. `account_cloud.rs` et `license.rs` contrôlent rôles/licences. | Réutiliser ces barrières pour chaque nouvelle mutation. Toute autorité construite côté frontend est informative ; le runtime relit ses preuves. Le changement national doit être propriétaire seulement et verrouillé après activité financière. |
| Ventes | Lignes et devis/factures ont des montants entiers et une devise texte. `database.rs:3701` `issue_invoice` valide IBAN CH/LI pour toute facture hors avoir avant numéro/snapshot/écritures. `bridge.ts:5707` émet via commandes existantes. | Autorité nationale lue dans la transaction ; émission US sans exigence IBAN/QR, mais avec détermination fiscale liée à l'entreprise, document/révision, date, adresses et montants exacts. Garder un refus explicite si sales tax nécessaire non configurée. |
| Commandes/récurrence/temps | `sales_fulfillment.rs:737`, `:835`, `:3291`, `recurrence.rs:315`, `:469`, `:689`, `time_billing.rs:427` imposent CHF. | Devise de l'entreprise et validation des sources figées ; adapter conversions, allocations, échéanciers et facturation de temps ensemble. Un devis USD isolé ne rend pas tout le cycle opérationnel. |
| Fournisseurs/achats | `schema.rs:331`, `:692`, `:714`, `:2516`, `:2733` ont des contraintes `currency = 'CHF'`. `supplier_invoices.rs:314`, `:318` écrivent CHF ; `:921` exige CHF. `invoiceScan.ts:14` accepte seulement CHF et taux CH. | Migration locale versionnée et vérifiée, puis source de devise centralisée dans commandes et factures fournisseur, avoirs, paiements et scan. Le modèle US ne doit jamais créer du crédit de TVA suisse. |
| Comptabilité | `accounting.rs:389` installe le plan suisse ; mappings et journaux sont déjà transactionnels, équilibrés, audités. `accounting.rs:3575` limite devise CHF/EUR. `accounting_closure.rs:112` refuse base != CHF et refuse agrégation multidevise non convertie. | Adapter starter chart et mappings par pays ; base USD ; maintenir refus d'agrégation non convertie. Séparer cash/accrual réel de cash-VAT suisse ; stocker date transaction/comptabilisation/paiement et source idempotente. Rapports et contrepassations restent backend. |
| Document figé/PDF | `FrozenIssuer`, `FrozenDocumentSnapshot` dans `types.ts:377/:438`, `build_issuer_snapshot` dans database ; `sales_pdf.rs` a une devise libre mais labels TVA/IDE/IBAN, A4 et QR suisses. `financial_pdf.rs` présente les états. | Ajouter profil national/langue/version dans nouveaux snapshots. Choisir rendu US Letter, labels EN, sales tax, instructions de paiement US. Ne pas modifier ni réinterpréter les anciens snapshots ; branche historique CH inchangée. |
| Présentation régionale | `language.ts:11` mappe toujours EN sur en-CH. `utils.ts` utilise cette locale globale, CHF par défaut ; projets et certains tableaux appellent `formatMoney` sans devise. | Juridiction indépendante de langue ; contexte de formatage attaché à l'entreprise pour USD/date/ZIP/téléphone, puis propagation des montants implicites de tableaux/budgets/catalogue. Ne pas convertir les textes utilisateur. |
| Agenda | `agenda.rs` garde dates/heures civiles ; frontend vient d'être traduit. Aucun fuseau IANA événement dans le contrat courant. | Fuseau de l'entreprise et provenance explicite de fuseau des imports. Vérifier DST/ambiguïté avant conversion ; préserver événements historiques dont le fuseau est inconnu. |
| Synchronisation | `company_sync_digest.rs` et `company_merge.rs` découvrent toutes les tables non locales ; `company_collaboration.rs:185` définit les tables locales exclues. Fusion compare colonnes/PK exactes et n'assimile pas tout nouveau schéma à l'ancien. | Nouvelle configuration doit être dans le contenu partagé, avec PK et règle de conflit. Tester 2 appareils CH/US et branche distante ancienne. N'ajouter aucune exemption de permission ou victoire silencieuse d'une configuration concurrente. |
| Sauvegarde | `backup.rs:1068` refuse archive venant de schéma plus récent ; `company_merge.rs:278` ne normalise que v60→61 sur copies jetables. | Prévoir compatibilité explicite de la nouvelle migration, conserver anciennes archives/snapshots ; aucune réinitialisation/destruction. Une migration SQLite différente doit être recettée avec ce vrai archiveur et mergeur. |
| Cloud | `account_cloud.rs` utilise allowlist de routes de compte ; la nouvelle route `/api/international/workspaces/[organizationId]/country` n'y est pas autorisée. | Endpoint appareil authentifié et contrat partagé ; jamais contourner allowlist avec une URL libre. Distinguer sélection nationale du workspace et métadonnées utilisateur, contrôler appartenance serveur. |

## Socle TypeScript réutilisable : contrats et limites

Le dossier `lib/international` n'est pas un runtime persistant. Ses parties pures utilisables comme spécification/adaptateur UI :

- `types.ts`, `country-config.ts`, `addresses.ts`, `phone.ts`, `localization.ts`, `money.ts` : CH/US, adresse, montants exacts JSON en cents décimaux string, zones IANA explicites, pas de conversion flottante ; profils absents conservés inconnus.
- `invoicing.ts` : Estimate, Contact, CustomerPayment, InvoicingAuthority, TaxRequest/TaxAssessment ; détermination attachée à l'empreinte complète et refus sans fournisseur fiscal configuré. Les identifiants, numéros, rôles, date d'audit et preuves du pilote sont fictifs et ne doivent pas devenir des preuves produit.
- `accounting/ledger.ts`, `postings.ts`, `reports.ts`, `reconciliation.ts` : calculs équilibrés, CAS révision, idempotence, contrepassations, cash/accrual et rapports. Ce sont des objets mémoire ; `postJournal` n'écrit pas de base et `actor` fourni au navigateur ne représente pas une autorité native.
- `documents.ts` : document US Letter, sales tax, absence de QR ; rendu HTML imprimable, pas générateur PDF Tauri ni archive commerciale.
- `automation.ts`, `subscriptions.ts` : ports injectés et règles testables, sans prestataire réel/sink transactionnel/catalogue US configuré.
- `workspace-service.ts` et `workspace-server.ts` importent des services/alias du site. **Ne pas les importer dans l'app desktop pour obtenir de la persistance.** Le desktop `tsconfig.json` n'a pas cet alias serveur. La route actuelle repose sur session navigateur/membership D1 et flag `INTERNATIONAL_CORE_ENABLED` ; le natif utilise d'autres credentials/appels.
- `desktop/tests/international-erp-pilot.tsx` donne uniquement une recette en mémoire, avec exemption fictive, client fictif, paiement fictif et aucune IPC. `InternationalCompanySetup.tsx` est réutilisable visuellement après adaptation de son `onSave` vers une vraie mutation.

## Ordre de livraison le plus direct

1. **Configuration native durable** : clone de la source actuelle sur D:, migration additive et contrat Rust/TS versionné, lecture workspace, commande propriétaire avec origine/nonce/idempotence, intégrité et verrouillage après activité. Branches historiques sans config inchangées. Ajouter tests migration/récupération/fusion/permissions avant onboarding.
2. **Onboarding US réel + formatage** : intégrer le composant de setup au vrai flux et ses validations Rust. Ajouter pays/juridiction/fuseau/base/language sans forcer modification des entreprises existantes. Clients et fournisseurs doivent se créer/réouvrir réellement dans la bonne entreprise.
3. **Cycle vente USD persistant** : devis→facture→paiement partiel→avoir/annulation, numérotation existante, instantanés et audit ; document US/EN/PDF. Ne pas désactiver la barrière sales-tax : fournisseur/registrations/exemption vérifiée, ou émission bloquée avec résolution compréhensible.
4. **Journal USD et rapports réels** : adapter moteur actuel ou port durable du contrat exact dans ses transactions. Tester équilibrage, reprise réponse perdue, contrepassation, périodes fermées, AR/AP, cash/accrual et rapports sans mélange CHF/USD.
5. **Achats/commandes/récurrence/catalogue** : migrations et IPC de tous les domaines CHF contraints, scan/Automation indépendant de TVA CH. Activation achats fournisseur doit préparer des écritures réellement persistées et autorisées.
6. **Cloud pilote US et entitlements** : relier configuration serveur validée aux appareils, tarifs US test isolés, analyse EN et timezone, réconcilier abonnements et permissions actuels. Pas de tarifs arbitraires production.
7. **Recette de l'ensemble** : vraie application Tauri base fictive, deux appareils/instances isolés, offline/reconnect et collisions, exports PDF réels, suite CH ciblée et suites native internationales. Le navigateur et le moteur pur seuls ne suffisent pas à déclarer ERP US livré.

Ce plan ne permet pas de garantir à lui seul la conformité réglementaire, qui doit être traitée par la recherche spécifique et la validation des prestataires/règles. Paie CH, eCH/TVA/QR suisse restent des capacités nationales ; leur présence en anglais ne doit pas les rendre activables pour une entreprise US.
