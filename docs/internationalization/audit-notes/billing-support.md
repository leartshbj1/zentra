# Audit International CH / US — abonnements, droits, Support et Automation

Revue de code en lecture seule du 7 octobre 2026. Seul ce document a été écrit. Aucun prix, produit Stripe, secret, webhook, serveur, migration, paiement ou donnée client n’a été modifié. Les tests cités ont été lus, pas exécutés pendant cet audit. « Réel » signifie présent dans le code inspecté, pas une certification de fonctionnement marchand en production.

## Sources distinctes à conserver

| Source | Provenance vérifiée | Portée de cette revue |
| --- | --- | --- |
| `C:/Users/alb/Documents/ChatGPT/chantier` | HEAD `dd64a18c34b44bb4c9d8e4c0a921a3602d3d8944`, nombreuses modifications locales préexistantes | Source demandée ; observations sur les fichiers de travail, pas uniquement sur le commit. Stripe Gestion historique et nouveau pilote US. |
| `D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable` | HEAD `82871714b1b56eb17eb43b4f1351959d8be880ff`, suivi Git propre lors de la lecture ; checkout associé à Site348 | Repérage complémentaire des modules Support/Automation et des contrôleurs récents absents du checkout C:. Aucun fichier copié ni modifié. Le statut du déploiement n’a pas été interrogé dans cette revue. |

Les chemins `C:` ci-dessous désignent la première source, les chemins `D:` la seconde. Les constats d’absence dans C: ne signifient **pas** que ces fonctions sont absentes du produit publié. Ne pas publier le vieux parcours C: à la place des contrôleurs D: lors de l’ajout du marché US.

Observation marchande transmise par le coordinateur pendant cette revue, non répétée par cet auditeur : lecture seule des Prices Stripe actifs (`active=true`, `limit=100`, `has_more=false`) sur le compte Zentra, **11 prix actifs tous CHF, aucun USD**. Gestion 49/59/89 et legacy 50 ; Support Starter 29/2 000 analyses, Team 49/5 000, Business 99/15 000 ; Automation 15 ; Complet Solo 79/Team 99/Pro 169 CHF par mois. Ce constat décrit le catalogue existant, n’approuve aucun prix US et ne prouve pas un paiement. Il correspond aux familles récentes du checkout D:, pas aux seules trois formules Gestion exposées par `lib/plans.ts` de C:.

Repérage D: : [Support billing](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/support/billing.ts:1120), [Support Jev](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/support/jev.ts:15), [Automation billing](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/billing.ts:318), [Automation droits](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/entitlement.ts:16), `lib/payments/stripe-{gestion,support,automation,complete}-purchase.ts`, `lib/payments/purchase-intents.ts`. Ces contrôleurs doivent servir de base d’intégration commerciale ; les bibliothèques de synchronisation native de C: constituent un autre périmètre.

## État constaté

| Sujet | État | Preuve et implication CH / US |
| --- | --- | --- |
| Catalogue Gestion | Réel CH, absent US dans C: | [plans.ts](C:/Users/alb/Documents/ChatGPT/chantier/lib/plans.ts:2) définit Solo/Start/Pro, montants CHF, identifiants de licence contenant `-chf` et 1/3/10 places. [runtime.ts](C:/Users/alb/Documents/ChatGPT/chantier/lib/runtime.ts:43) fournit un Price ID par formule, sans dimension marché/devise. Aucun prix USD ne doit être déduit des prix CHF. |
| Validation du Price | Réelle, spécifique CHF | [stripe-account.ts](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-account.ts:58) exige actif, mode exact, CHF, montant exact, périodicité mensuelle, usage licensed et tax behavior. [stripe.ts](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:338) revalide aussi le Price ID issu de la configuration actuelle. Remplacer ce mapping par USD rejetterait les abonnements CHF existants. |
| Langue Checkout / portail | Partielle | C: [stripe-checkout.ts](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-checkout.ts:14) force `fr` ; [stripe.ts](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:277) ne transmet pas de locale au portail. D: les quatre nouveaux contrôleurs figent `currentSiteLanguage()` : Gestion ligne584, Support445, Automation421, Complet547. Réutiliser cette séparation langue / commerce. |
| Moyens de paiement | Réels dans le builder C:, activation non vérifiée ici | `buildZentraCheckoutParams` omet `payment_method_types` et utilise `billing_mode: flexible` ([stripe-checkout.ts:13](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-checkout.ts:13)). Pas de carte seule imposée par ce builder. Aucun appel au compte marchand pendant l’audit : disponibilité CH/US et méthode affichée à un acheteur restent à vérifier dans un environnement autorisé. |
| Pays / fiscalité abonnement | Partiels | C: [stripe-checkout.ts:15](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-checkout.ts:15) collecte adresse/identité/tax ID et active automatic tax ; [stripe.ts:31](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:31) impose une tarification inclusive. [stripe-account.ts:89](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-account.ts:89) regarde les settings Tax, pas les registrations actives par juridiction. Leur statut, le traitement fiscal US et la politique de prix doivent être établis séparément ; aucune conformité fiscale US n’est démontrée. |
| Facture payée → droits | Réel CH | [stripe-event.ts:58](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-event.ts:58) exige facture paid, mode, abonnement et Price exacts, CHF, montant et ligne non proratisée ; la période provient de cette ligne. [stripe.ts:660](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:660) projette période et places payées. Le succès du navigateur ou `subscription.active` seul ne suffit pas. USD est rejeté par construction. |
| Webhooks et reprise de licence | Réels, mais ancien socle C: | [stripe.ts:607](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:607) vérifie signature, mode et version ; [stripe.ts:738](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:738) journalise/reprend l’événement. [license-token.ts:371](C:/Users/alb/Documents/ChatGPT/chantier/lib/license-token.ts:371) relit la dernière facture pour renouveler même si son webhook manque. Ne pas confondre cela avec la réservation d’un achat durable. |
| Achat simultané / réponse perdue | Incomplet dans C:, socle récent présent dans D: | C: [checkout/route.ts:44](C:/Users/alb/Documents/ChatGPT/chantier/app/api/stripe/checkout/route.ts:44) crée une claim aléatoire à chaque requête, puis écrit `checkout_attempts` après le POST Stripe. La clé [stripe.ts:149](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:149) est stable seulement pour cette claim. Deux clics ou une réponse perdue puis une nouvelle requête ont des claims distinctes. D: `D1PurchaseIntents` et les quatre contrôleurs constituent le raccordement à conserver ; ne pas ajouter US au vieux flux avant cette convergence. |
| Refund / dispute / crédit Stripe | Non raccordé dans le flux C: inspecté | La liste [stripe.ts:32](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe.ts:32) et le dispatcher ligne761 ne couvrent pas les remboursements, litiges ou credit notes Stripe. [stripe-sql.ts:3](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-sql.ts:3) conserve `MAX(entitlement_valid_until)`, sans tombstone de remboursement dans ce module. Un remboursement ne retire donc pas les droits par ce chemin C:. Ce constat ne s’applique pas automatiquement aux nouveaux sinks D:. |
| Licence native USD | Absente dans C: | Le contrat signé possède `price_chf_cents` ([license-token.ts:38](C:/Users/alb/Documents/ChatGPT/chantier/lib/license-token.ts:38)), le serveur contrôle `validLicensePrice`, et le client Rust accepte les seuls plans/montants CHF ([license.rs:33](C:/Users/alb/Documents/ChatGPT/chantier/desktop/src-tauri/src/license.rs:33), validation ligne1767). Un nouveau Price USD seul ne rend pas l’application US activable. |
| Expiration / fuseau licence | Partielle | Les périodes payées sont en epoch UTC ; le payload convertit en dates UTC et ajoute une grâce de trois jours ([license-token.ts:52](C:/Users/alb/Documents/ChatGPT/chantier/lib/license-token.ts:52), ligne230). Il faut documenter la frontière exacte d’expiration entre serveur et appareils de fuseaux différents, sans modifier implicitement la grâce CH. |
| Permissions | Réelles, à préserver | C: [account.ts:141](C:/Users/alb/Documents/ChatGPT/chantier/lib/account.ts:141) lie session, installation, entreprise, activation non révoquée, membre, expiration et places ; renouvellement [license-token.ts:405](C:/Users/alb/Documents/ChatGPT/chantier/lib/license-token.ts:405) recontrôle les mêmes liens. [zentra-auth.ts:28](C:/Users/alb/Documents/ChatGPT/chantier/app/zentra-auth.ts:28) utilise l’ID Supabase stable et l’e-mail confirmé. `user_metadata` sert ici au nom affiché ([supabase-auth.ts:345](C:/Users/alb/Documents/ChatGPT/chantier/lib/supabase-auth.ts:345)), pas à un droit pays/formule. |
| Essai US un mois | Offre enregistrée, activation absente | [markets/us.ts:14](C:/Users/alb/Documents/ChatGPT/chantier/lib/markets/us.ts:14) promet un mois à l’activation US, sans carte/renouvellement. [us-pilot/validation.ts:108](C:/Users/alb/Documents/ChatGPT/chantier/lib/us-pilot/validation.ts:108) enregistre `offer_version` ; la migration [20261007173315:6](C:/Users/alb/Documents/ChatGPT/chantier/supabase/migrations/20261007173315_us_pilot_free_month_offer.sql:6) précise que ce n’est ni compte ni entitlement. Aucun démarrage effectif d’essai, quota ou activation US n’est démontré par ce formulaire. D: [complete/trial.ts:4](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/complete/trial.ts:4) possède séparément l’essai Complet de 14 jours. |
| Pilote Supabase | Réel pour candidatures, pas facturation | [us-pilot/server.ts:64](C:/Users/alb/Documents/ChatGPT/chantier/lib/us-pilot/server.ts:64) valide même origine, corps borné, anti-spam et UUID de soumission ; insertion idempotente du lead. [migration du pilote:47](C:/Users/alb/Documents/ChatGPT/chantier/supabase/migrations/20261007165615_us_pilot_market_test.sql:47) active RLS et retire les accès directs anon/authenticated. Les UUID de lead/event ne sont pas des preuves d’abonnement. Application effective de ces migrations hébergées non contrôlée ici. |
| Langues natives | Réelles mais locales CH | [desktop/src/language.ts:7](C:/Users/alb/Documents/ChatGPT/chantier/desktop/src/language.ts:7) offre FR/DE/IT/EN, avec `fr-CH/de-CH/it-CH/en-CH`, préférence locale. `English` ne sélectionne donc pas un marché américain ni USD. |

## Support et Automation : état du checkout D: récent

Ces éléments ont été relus dans D:, car aucune implémentation serveur Jev/Support/Automation correspondante n’est présente dans `C:/…/chantier/lib` ou `app/api`. L’outil `founder-signer` présent dans C: sait demander des offres Support/Automation à un serveur externe ; ses scripts et README ne remplacent pas ces implémentations.

| Sujet | État | Preuve / limite |
| --- | --- | --- |
| Langue des messages | Réelle FR/DE/IT/EN | [support/jev.ts:79](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/support/jev.ts:79) demande une langue typée, `other` si ambiguë/mélangée, et valide les choix/confiances ligne118. Le prompt ligne21 traite le contenu comme non fiable et interdit approbation de paiement/refund/accès. [support/solicitation.ts:21](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/support/solicitation.ts:21) fournit les quatre langues de modèles de réponse. Cela prouve un contrat de traitement multilingue, pas la qualité US mesurée du modèle. |
| Droit et consentement Jev | Réels | [automation/entitlement.ts:16](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/entitlement.ts:16) résout l’accès de la société, base Gestion, période payée/mode et remboursements ; ligne60 recontrôle membre/rôle/places. [automation/service.ts:78](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/service.ts:78) exige droit, consentement et flags ; lignes181/183 recontrôlent avant/après le provider. Pays/langue client ne doivent jamais contourner ces gardes. |
| Idempotence et quotas | Réels, à réutiliser | [automation/service.ts:105](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/service.ts:105) fingerprint du contexte/société/rôle/politique et réservation ; [automation/workflows.ts:340](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/workflows.ts:340) lease + révision, fin liée au lease. [support/billing.ts:462](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/support/billing.ts:462) réserve une analyse dans la période et le quota réel. Ne pas remettre les compteurs à zéro lors d’un changement de langue/pays. |
| Journée locale | Réelle CH, non paramétrable US | [automation/activity.ts:9](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/activity.ts:9) impose `Europe/Zurich`, avec minuits DST 23/25h ; les tests de service ligne488 couvrent ce calendrier suisse. Une équipe US peut donc voir « aujourd’hui » basculer à la mauvaise heure. |
| Rendez-vous | Partiel pour US | [appointments/extraction.ts:239](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/appointments/extraction.ts:239) dit explicitement que les heures sans fuseau sont Zurich ; lignes290/297 signalent le fuseau et valident les changements d’heure de Zurich. Il faut une zone IANA autorisée de l’entreprise, la zone explicite du message/ICS et une gestion honnête des heures ambiguës, plutôt qu’une simple traduction. |
| Factures / devise | Extraction partielle, import US absent | [supplier-inbox/extraction.ts:114](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/supplier-inbox/extraction.ts:114) reconnaît CHF/EUR/USD/GBP mais ligne230 exige traitement manuel hors CHF. C: [supplierEmail.ts:104](C:/Users/alb/Documents/ChatGPT/chantier/desktop/src/supplierEmail.ts:104) bloque aussi l’import hors CHF ; [supplier_email.rs:225](C:/Users/alb/Documents/ChatGPT/chantier/desktop/src-tauri/src/supplier_email.rs:225) fait de même. L’exemple américain à `$…` ne démontre pas une écriture comptable USD. |
| Devise manquante | Risque concret US | [automation/policies.ts:157](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/policies.ts:157) accepte trois lettres mais remplace une devise absente/invalide par CHF. Pour un profil US, garder l’incertitude ou la devise de base confirmée ; ne jamais transformer `$` ambigu ou devise absente en certitude CHF/USD. |
| Abonnements Support/Automation | Réels CH, pas catalogue USD | [support/billing.ts:650](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/support/billing.ts:650) et ligne893 exigent CHF ; [automation/billing.ts:63](D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable/lib/automation/billing.ts:63) et ligne171 également. Les contrôleurs récents figent locale et paramètres, mais restent des offres CHF. Aucun prix USD ou conversion n’est proposé par cet audit. |

## Défauts / risques à traiter avant un véritable lancement US

1. **Choisir une base commune de release.** Conserver les contrôleurs durables de D: et les évolutions natives/C: avec un plan d’intégration vérifié ; ne pas réintroduire le double Checkout possible du flux C: ni sa gestion de refunds absente. Le changement de marché ne doit pas effacer les réservations ni les achats incertains.
2. **Découpler catalogue commercial et langue.** Un utilisateur anglophone CH conserve CHF. Un utilisateur US ne doit pas recevoir un Price CHF silencieusement. Versionner et figer marché/devise/Price/conditions avant le POST, et retrouver l’ancien snapshot en reprise. Ne jamais recalculer les paramètres d’une ancienne intention à partir du marché courant.
3. **Faire évoluer le contrat de licence avec compatibilité explicite.** L’actuel `price_chf_cents` et la liste native CHF empêchent USD. Prévoir un nouveau contrat signé/versionné et une transition conservant les licences CH existantes ; un profil client ou une traduction n’accorde pas de droits.
4. **Paramétrer les calendriers et les faits extraits.** Journée de l’entreprise, fuseau des événements, dates numériques ambiguës, devise source et fiscalité du document doivent rester distincts. La classification Jev ne décide ni un taux fiscal ni une conversion.
5. **Raccorder réellement le pilote si l’accès US est ouvert.** Offre enregistrée → activation datée explicite → période d’un mois calendaire/quota approuvés → expiration ; aucun débit ni reconduction sans nouveau choix payé. Le simple statut du lead `pilot` ne doit pas devenir une licence.

Une autre faiblesse de l’ancien journal C: mérite une revue ciblée : [stripe-sql.ts:11](C:/Users/alb/Documents/ChatGPT/chantier/lib/stripe-sql.ts:11) peut réattribuer le traitement après cinq minutes, mais les UPDATE de fin/libération lignes16/19 ne vérifient pas un propriétaire de lease. Un ancien traitement peut finaliser/libérer après une reprise. Ce constat de code n’a pas été reproduit en test pendant cette mission ; ne pas l’importer dans le socle récent.

## Interfaces réutilisables proposées — pas implémentées

```ts
type MarketId = 'CH' | 'US';
type InterfaceLanguage = 'fr' | 'de' | 'it' | 'en';

type BusinessContext = {
  organizationId: string; // issu du compte/membre autorisé
  revision: number;
  market: MarketId;
  countryCode: string;
  subdivisionCode: string | null; // distinct du choix de langue
  language: InterfaceLanguage;
  locale: string;
  timeZone: string; // IANA validé, confirmé par l'entreprise
  accountingCurrency: string; // distinct de la devise de l'abonnement
};

type FrozenCommercialOffer = {
  catalogVersion: string;
  product: 'gestion' | 'support' | 'automation' | 'complet';
  planKey: string;
  market: MarketId;
  currency: string;
  unitAmountMinor: number; // entier du catalogue approuvé, jamais déduit du CHF
  taxBehavior: 'inclusive' | 'exclusive';
  stripePriceId: string;
  environment: 'TEST' | 'PRODUCTION';
  conditionsVersion: string;
};

type ExtractedMoney = {
  amountMinor: number | null;
  currency: string | null;
  sourceEvidence: string; // extrait/document, aucune invention
  confidence: number;
};
```

`resolveCommercialOffer` doit être serveur, sans fallback de marché/devise. L’intention durable fige owner, entreprise/espace, offre, langue Checkout, conditions et paramètres exacts ; les readers de droits reçoivent une preuve/période et un snapshot de capacités, indépendants de la devise affichée. Réutiliser `D1PurchaseIntents`, les quatre contrôleurs Stripe et les vérificateurs de paiements existants, pas une deuxième orchestration.

`resolveBusinessContext` doit lire une entreprise autorisée et revalider sa révision au moment d’exécuter une action. Jev reçoit uniquement le contexte utile non secret ; langue détectée du message distincte de langue UI. Une zone ou une devise manquante produit une vérification humaine. Les périodes d’abonnement restent des instants UTC ; seule la présentation/planification locale dépend du fuseau.

## Validations nécessaires, sans inventer prix ni taux

Les tests existants sont des points de départ : C: `lib/stripe-checkout.test.ts:14`, `stripe-plans.test.ts:66/106`, `stripe-event.test.ts:125`, `stripe-sql.test.ts` ; D: `lib/automation/service.test.ts:131/169/206/267/488`, `lib/support/solicitation-service.test.ts:156/175/215`, les tests des quatre contrôleurs durables. Leur présence ne constitue pas un nouveau résultat d’exécution.

- **Matrice commerciale CH/US** : chaque produit/formule, Price/mode/devise/catalogue exacts ; absence de configuration US → indisponible explicite ; abonnements CHF antérieurs encore renouvelables après introduction de USD. Prix et traitement fiscal d’abord approuvés, puis fixtures basées sur ce catalogue.
- **Reprises et droits** : doubles clics/deux appareils/réponse perdue, contexte modifié, mauvais owner/espace, compte supprimé, refund/dispute, événement tardif et lease périmé ; un seul achat, aucun droit avant preuve, aucun deuxième POST après issue financière incertaine.
- **Licence et essai** : client ancien/nouveau, plan/currency inconnus refusés, expiration au même instant sur plusieurs fuseaux, essai US activé une fois, aucun reset du quota ou renouvellement automatique ; inscription au pilote seule sans accès.
- **Jev et documents** : corpus FR/DE/IT/EN fictif, messages mixtes, injection de prompt, direction du démarchage ; USD explicite/`$` ambigu/devises multiples, formats monétaires et dates ambigus ; proposition conservée pour contrôle, aucune taxe supposée ni écriture automatique hors capacités.
- **Agenda/activité** : Zurich/New York/Los Angeles, minuits et changements DST non simultanés, heure inexistante/doublée, zone ICS explicite et absence de zone ; autorisation révoquée pendant l’analyse et rejouée sur un autre appareil.
- **Prêt marchand** : vérification autorisée du catalogue et des registrations actives, Checkout/renouvellement sandbox par marché/méthode, webhook signé et remise en service. Cet audit n’a exécuté aucun de ces essais et n’atteste aucun encaissement réel.

## Références primaires consultées

Les [Prices multidevises Stripe](https://docs.stripe.com/products-prices/manage-prices) et [modification d’une souscription](https://docs.stripe.com/billing/subscriptions/change-price) fournissent des primitives, pas un nouveau catalogue US approuvé. La [mise en place SaaS Stripe](https://docs.stripe.com/get-started/use-cases/saas-subscriptions) distingue Checkout terminé et paiement réellement confirmé. Les obligations fiscales restent à établir avant de changer automatic tax ; consulter les [registrations Stripe Tax](https://docs.stripe.com/tax/registering).

La [documentation Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) rappelle la séparation authentification/autorisation. Cette revue n’a interrogé ni le schéma hébergé, ni les politiques en vigueur, ni les réglages du marchand. Les skills Stripe best practices et Supabase ont servi de cadre ; les observations produit ci-dessus ont été recontrôlées dans les fichiers actuels.
