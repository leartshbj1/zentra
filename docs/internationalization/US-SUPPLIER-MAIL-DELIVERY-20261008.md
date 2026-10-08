# Zentra US — propositions de factures fournisseurs et revue comptable

8 octobre 2026. Base de cette phase : `1e100d26f17594c5bfa62d24c151b60372856d38`. Développement isolé sur la branche `codex/international-runtime`. Le menu du site public est publié séparément en version355, source `b6e080ba6ad75c825c383ab5ae7282201e7f8a7f` ; ce lot US n'est pas publié et n'a modifié aucune donnée cliente, offre CHF ou installation native.

## 1. Modifications et comportement

Le nouveau parcours conserve un document et son extraction comme **proposition non fiable**, distincte du livre comptable. Un owner/admin/accountant autorisé vérifie le fournisseur enregistré, la référence, les dates, la période ouverte, le montant net et la taxe imprimée ; deux confirmations explicites précèdent l'enregistrement. Celui-ci utilise la commande fournisseur existante, les écritures cash/accrual existantes et une seule transaction PostgreSQL pour la proposition, le commit ERP et l'audit. Il ne paie pas le fournisseur.

Les montants financiers sont des chaînes d'entiers en unités mineures, calculés en BigInt/NUMERIC. Une devise imprimée connue autre que USD interdit l'enregistrement : pas de conversion implicite EUR/CHF. Une devise absente laisse les montants à saisir et impose la confirmation humaine du document USD. La taxe imprimée est un coût d'achat ; aucune TVA suisse, déduction fiscale, sales tax ou use tax n'est calculée par ce flux.

L'extracteur sélectionne des candidats présents dans le texte avec preuves et confiance par champ. Un champ absent reste null, jamais un zéro inventé. Les dates numériques suivent explicitement MM/DD/YYYY dans cet adaptateur US ; ISO et mois anglais sont également validés. Cette convention ne prouve pas celle du fournisseur : l'original et les dates doivent être vérifiés avant approbation. Ni confiance élevée ni contenu d'un document ne donnent une permission financière.

La liste d'activité mène à un écran de revue simple, disponible en FR/DE/IT/EN et en clair/sombre. Le texte source est échappé. Aucun fournisseur ou exercice n'est sélectionné automatiquement. Les brouillons survivent à un changement de révision sans changer d'identité ; une confirmation devenue périmée doit être refaite. Le changement d'espace/compte/rôle ou une perte d'accès purge les données privées.

Une requête au résultat incertain conserve exactement son corps et sa clé en mémoire. Les autres mutations ERP, vendeur, fiscalité et banque sont bloquées jusqu'à sa reprise explicite. Une reprise retrouve le reçu initial sans seconde facture ni seconde écriture. Les verrous, revues et messages sont distincts d'un état de connexion au réseau.

## 2. Fichiers créés

- Contrats et validation : `lib/international/us-supplier-contract.ts`, `us-supplier-proposal.ts`, `us-supplier-proposal.test.ts`, `erp-receipt.ts`.
- Extraction : `lib/international/us-supplier-extraction.ts`, `us-supplier-extraction.test.ts`.
- Services/autorisation : `lib/international/us-supplier-server.ts`, `us-supplier-server.test.ts`, `us-supplier-bindings.ts`, `us-supplier-bindings.test.ts`.
- Persistance : `lib/international/us-supplier-store.ts`, `us-supplier-store.test.ts`, `us-supplier.postgres.test.ts`.
- Transport/copie : `lib/international/browser-us-supplier-session.ts`, `browser-us-supplier-session.test.ts`, `browser-us-supplier-copy.ts`.
- Interface : `components/account/us-supplier-proposals.tsx`, `us-supplier-proposals.css` ; tests `lib/international/browser-us-supplier.browser.test.ts`, `browser-us-supplier-workbench.browser.test.ts`.
- Route : `app/api/international/workspaces/[organizationId]/supplier-proposals/route.ts`.
- Migration : `supabase/migrations/20261008194930_international_us_supplier_proposals.sql`.
- Documentation : `US-SUPPLIER-MAIL-PLAN-20261008.md`, `US-SUPPORT-AUTOMATION-RESEARCH-20261008.md`, ce rapport et `docs/evidence/us-supplier-proposals-20261008.json`.

La preuve consolidée donne les chemins complets du dépôt et leurs empreintes normalisées. Les fichiers QA locaux sont ignorés par Git et restent distincts de la preuve versionnée.

## 3. Fichiers modifiés

- `app/compte/espaces/us/[organizationId]/page.tsx` : disponibilité US/cap4 et droit Automation distinct du droit Gestion ; aucun droit déduit d'un indicateur d'interface.
- `components/account/us-erp-workbench.tsx` : panneau Achats, isolation de session, conservation des brouillons et verrous mutuels avec les autres écritures.
- `lib/international/runtime-store.ts` : extraction inchangée du validateur pur de reçu vers `erp-receipt.ts`, afin que le navigateur n'importe pas le runtime serveur Supabase.
- `lib/international/workspace-creation.integration.test.ts` : ajout de la nouvelle migration à la liste exacte de la chaîne de création ; pas de réécriture d'une migration historique.

## 4. Migration et retour arrière

La migration a été générée avec la CLI Supabase2.120.0 puis complétée de façon additive. Propositions et audit privés, RLS activée, aucun grant anon/authenticated, cinq RPC fixes INVOKER à search_path vide. L'autorité Auth/D1 et les droits Gestion/Automation restent vérifiés par HTTP avant et après les attentes ; le rôle serveur privilégié n'est pas une identité utilisateur.

La configuration, la tête ERP et la proposition sont verrouillées dans un ordre commun. La comparaison de révision et les contraintes différées corrèlent la revue, le reçu et le journal. Le nouveau namespace de facture exige l'approbation source pour les nouveaux événements seulement : aucun balayage, reclassement ou rehash de l'historique. La source est immuable ; déduplication SHA+texte+type sans modifier son auteur, nom ou horodatage d'origine. Les listes sont bornées à50 propositions et un budget conservateur de2Mo avant mutation.

**Aucune migration hébergée exécutée.** Elle est testée dans une base PostgreSQL/WASM jetable avec la chaîne complète. Le retour arrière prévu consiste à désactiver `INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED` et conserver les preuves privées ; pas de suppression de factures, tables historiques ou comptes. Une éventuelle suppression ultérieure des nouveaux objets exigerait une procédure séparée et une approbation explicite.

## 5. Tests exécutés et preuves

Les résultats finaux et commandes sont consignés dans `docs/evidence/us-supplier-proposals-20261008.json`. Les suites source/HTTP/PostgreSQL utilisent uniquement des données fictives. La suite internationale inclut96 tests d'extraction,105 de contrat,32 de service HTTP,77 de transport RPC,48 PostgreSQL,12 de binding et30 de transport/revue navigateur pour ce nouveau lot. Ces sous-comptes font partie de la suite globale ; ils ne doivent pas être additionnés une seconde fois.

La suite internationale complète finale passe :4.710 réussites,0 échec,12 tests navigateur non activés,120 fichiers. La suite précédente avait11 exclusions, avant ajout de la dernière régression. Les six fichiers suisses ciblés passent52/52 (Auth, Checkout, contrat et webhook Stripe). Les31 tests ciblés UI incluent30 tests de transport/revue et un vrai navigateur avec React/HTTP/moteur ERP, stockage et identité fictifs. Une régression supplémentaire d'intégration sur le véritable workbench passe1/1 et vérifie les verrous entre fournisseur et banque après résultat incertain, avec une seule facture et une seule écriture. Les deux parcours navigateur sont exécutés séparément de la suite globale où ils sont exclus par défaut.

TypeScript, lint syntaxique ciblé, vérification des actifs de marque, build de production Vinext et diff whitespace passent sur les sources finales. La compilation intermédiaire a été interrompue pendant transform avec le code Windows `-1073740791` ; sa cause n'est pas établie. La compilation suivante, exécutée seule après les tests, a terminé avec succès ; le journal de l'échec reste conservé. Le lint typé n'a pas pu être exécuté : Windows refuse le lancement de tsgolint (`UNKNOWN/-4094`). Le lint syntaxique et le typecheck ne sont pas présentés comme une réussite du lint typé.

Revue visuelle locale :16 variantes (FR/DE/IT/EN × clair/sombre × desktop1200/mobile320, texte mobile200%), sans débordement observé ; capture FR390 supplémentaire. La matrice a été exécutée avant correction de deux fixtures de devise et d'un verrou de lecture locale de fichier sans changement de mise en page. La confirmation fonctionnelle passe séparément ; aucune troisième matrice esthétique ou preuve sur appareil physique n'est revendiquée.

Les défauts reproduits sont conservés : admission silencieuse EUR par RPC et transaction privilégiée, compte attendu lu via getter, UUID insuffisant, indicateur périmé après vérification Automation, perte de pending lors d'un disabled parent et callbacks banque oubliant les états fournisseur. Les corrections ne remplacent pas les assertions par une réussite artificielle.

## 6. Risques et limites

- Le binding réel reste **`analyzer:null`** et l'interface **`analysisAvailable=false`**. Activer un flag ou payer Automation ne donne pas un prestataire prêt. Les essais injectent un analyseur fictif ; aucun appel TypeSafe ou e-mail réel n'a eu lieu.
- La connexion Support US n'est pas raccordée. Le worker historique suppose des membres, consentements, quotas et devises CH/CHF : il ne doit pas être utilisé silencieusement comme délégation US. Préparer quota, consentement, leases, retries et droits d'un même espace US avant l'intake réel.
- Le point d'entrée navigateur prépare du texte manuel borné à16.384 octets. Le modèle peut représenter une provenance PDF serveur, mais aucun upload PDF/OCR ni archive originale privée n'est livré ici. Le texte extrait ne constitue pas un archivage complet conforme à l'IRS.
- La propagation des nouvelles propositions entre plusieurs sessions nécessite encore une notification/lecture de changements dédiée. Les essais prouvent la reprise et les révisions locales, pas un flux de messagerie partagé live.
- Les tests PostgreSQL/WASM utilisent une seule instance locale sérialisée. Aucun test de charge150 entreprises, PostgreSQL hébergé multiconnexion, Auth/Stripe live ou appareil physique n'est revendiqué.
- Le compte d'achat actuel est `purchases`. Immobilisations, stocks, prorata, use tax, déductibilité, conventions de dates d'autres fournisseurs et choix de période fiscale ne sont pas déterminés automatiquement.

## 7. Terminé dans ce jalon isolé

Contrats bornés et immuables, extraction candidate en anglais, stockage d'une proposition par espace, revue humaine, enregistrement atomique par le moteur ERP existant, piste d'audit, déduplication/reprise, contrôle de devise, droits frais, traduction et rendu responsive. Aucun moteur CH, binaire natif ou abonnement CHF modifié.

## 8. Expérimental et prochaine étape

Ce jalon est une verticale de pilote source et non un service US de messagerie déjà activé. Le moteur fiscal reste non raccordé ; ni taxe US déterminée, certification US GAAP, paiement ACH, prix USD de production, migration hébergée ni binaire Windows/macOS/iOS/Android n'est livré par cette phase.

La prochaine étape est l'admission serveur d'un workflow Support/Automation US : consentement de traitement, quota propre à l'espace, provenance et archive privée, idempotence d'analyse, retries bornés et registre de délégation. Le raccordement réel et son évaluation TypeSafe exigent les droits/contrats et la validation applicables ; toute modification de production reste soumise à l'approbation explicite demandée. L'objectif ERP international demeure actif et incomplet.
