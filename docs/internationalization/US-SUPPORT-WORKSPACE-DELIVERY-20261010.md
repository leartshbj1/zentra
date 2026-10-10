# Support US — registre par entreprise, livraison H1

10 octobre 2026. Branche isolée `codex/international-runtime`, base `8236d41ea2be8353e42710035488b35a0b294c95`. Périmètre défini avant développement dans [le plan H1](US-SUPPORT-WORKSPACE-PLAN-20261010.md). L'objectif d'un ERP US complet demeure actif.

Commit d'implémentation vérifié : `03b37c9be0d253eede743d312cb41cf2de16ced0`. Les preuves et l'inventaire final figurent dans [le manifeste](../evidence/us-support-workspace-20261010.json).

Cette livraison prépare un espace Support propre à une entreprise US. **Elle ne connecte pas de boîte mail, ne reçoit pas de messages et ne classe pas de tickets.** Les abonnements et données CH, la copie native et le site public restent préservés.

## 1. Modifications

- Registre par entreprise US, indépendant du parent Support legacy unique par propriétaire. Deux entreprises du même propriétaire ne partagent pas leur espace.
- Préparation réservée au propriétaire ou administrateur courant. Lecture pour les membres actuels admis. Gestion et Support doivent être prouvés sur la même facture et période US/USD effectives ; seul Complet inclut actuellement Support dans le parcours initial US.
- Contrôles serveur avant et après les opérations asynchrones : identité, appareil éventuel, rôle, abonnement, catalogue, période et gates. Un renouvellement pendant le dernier contrôle Auth ne laisse plus revenir l'ancienne période.
- Reçu atomique et immuable, lié à l'entreprise, l'acteur et la requête exacte. Une réponse perdue se reprend sans nouvel espace ; réutiliser l'identifiant avec un nom différent est refusé. Aucun renommage ni réaffectation implicite.
- Route privée `GET/POST /api/international/workspaces/{organizationId}/support-workspace`, réponses non mises en cache, erreurs publiques bornées et diagnostics sans contenu métier. Une requête navigateur ne peut pas emprunter une session appareil, ou inversement.
- Panneau FR/EN/DE/IT dans les réglages US, utilisable sans livre comptable initialisé. Lectures silencieuses nominales toutes les 30 secondes lorsque la page est visible et connectée ; aucun POST automatique. La reprise incertaine demeure en mémoire dans l'onglet. Changer de compte ou perdre l'accès efface les données et arrête les lectures.

## 2. Fichiers créés

18 fichiers nouveaux dans la livraison, preuves comprises :

- `app/api/international/workspaces/[organizationId]/support-workspace/route.ts`
- `components/account/us-support-workspace-panel.tsx`
- `drizzle/0093_international_us_support_workspaces.sql`
- `lib/international/us-support-workspace-contract.ts`
- `lib/international/us-support-workspace-contract.test.ts`
- `lib/international/us-support-workspace-server.ts`
- `lib/international/us-support-workspace-server.test.ts`
- `lib/international/us-support-workspace-bindings.ts`
- `lib/international/us-support-workspace-bindings.test.ts`
- `lib/international/us-support-workspace-d1.ts`
- `lib/international/us-support-workspace-d1.test.ts`
- `lib/international/us-support-workspace-ui.test.ts`
- `docs/internationalization/US-SUPPORT-WORKSPACE-PLAN-20261010.md`
- `docs/internationalization/US-SUPPORT-WORKSPACE-DELIVERY-20261010.md`
- `docs/evidence/us-support-workspace-20261010.json`
- `docs/evidence/us-support-workspace-20261010/mobile-dark-fr.jpg`
- `docs/evidence/us-support-workspace-20261010/desktop-owner-en.jpg`
- `docs/evidence/us-support-workspace-20261010/desktop-member-en.jpg`

Les rapports détaillés et la fixture locale sous `.qa/us-support-workspace` sont ignorés par Git. Le manifeste conserve leurs compteurs, commandes et empreintes, ainsi que la sélection exacte de régression.

## 3. Fichiers existants modifiés

| Fichier | Effet |
|---|---|
| `app/compte/espaces/us/[organizationId]/page.tsx` | Affordance Support sous gate et droits US ; réglage autonome, sans redirection vers l'espace legacy. |
| `components/account/us-erp-workbench.tsx` | Montage optionnel hors de la préparation financière, propagation synchrone de l'invalidation d'accès. |
| `docs/internationalization/STATUS-20261009.md` | État réel de H1 et prochaines verticales. |
| `vitest.config.ts` | Résolution du module virtuel de langue vers le véritable adaptateur SSR utilisé par le build. |
| `lib/support/application-effects.test.ts` | Observation des données transmises à la vue, indépendante de l'ordre des hooks React. |

Les transports et tables Support legacy, les anciennes migrations, les autorités et routes CHF, les sources natives et le worktree public ne sont pas modifiés.

## 4. Migration proposée et retour arrière

La migration D1 additive **0093** crée `international_us_support_workspaces`, `international_us_support_workspace_receipts` et la vue `international_us_support_admissible`. Elle n'altère pas les parents, index ou clés étrangères legacy. Les reçus et le registre ont des clés étrangères différées réciproques, confirmées dans un même batch. Le premier auteur, nom et instant restent conservés.

Les gardes SQL corroborent les faits US retenus : entreprise READY, véritable owner et membres actifs, capacité, abonnement effectif, offre Complet, facture/période, session appareil et JSON exact. Elles ne remplacent ni Auth ni le catalogue approuvé côté serveur. Les mises à jour, suppressions et remplacements du nouvel historique sont refusés. Une migration absente donne une indisponibilité explicite.

**Aucune migration hébergée appliquée.** Les essais utilisent la vraie chaîne SQLite locale 0000–0093 avec Auth, catalogue et paiement fictifs. Aucune nouvelle migration PostgreSQL n'est proposée pour H1.

`INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED` reste fermée par défaut et dépend des gates Core/ERP. Retour arrière applicatif : fermer la gate, revenir au code précédent si nécessaire, conserver le registre et ses reçus. Aucun rollback SQL destructif automatique. Toute application ou activation en production attend l'approbation explicite demandée par l'utilisateur.

## 5. Tests exécutés et preuves

Résultats définitifs et commandes dans [le manifeste](../evidence/us-support-workspace-20261010.json). Les contrôles incluent le contrat, HTTP, le transport navigateur et l'interface, l'autorité effective SaaS et la vraie chaîne SQLite. Les cas exercés couvrent isolation, rôles, Gestion seul, période renouvelée, révocation, déconnexion, reprise exacte, concurrence, corruption et immutabilité.

| Contrôle final | Résultat |
|---|---|
| Régression sélectionnée, 84 fichiers | **2 719/2 719**, aucun échec, skip, todo ni suite en échec |
| Cohorte H1 incluse dans ce total, 5 fichiers | **132/132**, dont **53/53** du store D1 sur SQLite réel |
| Harnais Support et langues relancé après correction | **39/39**, également compris dans la régression globale |
| TypeScript global, lint typé des fichiers TS/TSX concernés, marque et compilation production | Réussis ; commandes et empreintes conservées |

La compilation production, TypeScript global, le lint typé ciblé et le contrôle de marque sont vérifiés séparément. La sélection de régression inclut les nouveaux tests ; les compteurs ciblés ne s'ajoutent pas au total agrégé.

Inspection navigateur de **l'interface React réelle avec Auth et persistance simulés**, pas d'un compte hébergé : FR/DE/IT/EN, clair/sombre à 320 × 900, puis ordinateur à 1280 × 900. Aucun débordement horizontal observé. Hauteur des boutons au moins 45,75 px ; le libellé allemand passe sur deux lignes. Après une réponse POST perdue, la reprise a conservé exactement la même demande : un commit, deux POST. La révocation et la déconnexion ont purgé l'affichage ; le membre ne disposait d'aucun formulaire de création. Captures conservées dans le manifeste.

La première régression élargie a exécuté 2 713 tests avec succès, mais une suite Support ne chargeait pas son module virtuel de traduction. Résoudre celui-ci avec le véritable adaptateur SSR a ensuite révélé un ancien helper de test attaché au deuxième hook React : il lisait désormais un brouillon à la place des données. Le helper observe maintenant les props transmises à la vue. Les cycles de requêtes réels restent exécutés, sans modifier le composant ni simuler ses loaders. Les contrôles concernés ont été relancés avant la régression finale.

Les essais initiaux infructueux sont conservés sous `.qa` ; ils ne sont pas présentés comme réussis. La preuve de compilation finale utilise le chemin CLI vérifié du package installé. Le viewport temporaire, l'onglet et le serveur de test ont été fermés.

## 6. Risques et limites

- Ce registre est H1 seulement ; aucune connexion, boîte, réception, classification, routage ou délégation worker US n'est délivrée.
- Le rafraîchissement de métadonnées à 30 secondes ne constitue pas une preuve Realtime hébergée ni une mesure de charge pour 150 entreprises.
- Auth, Stripe et les credentials de test sont fictifs ; SQLite Node ne prouve pas à lui seul la composition Cloudflare D1/workerd hébergée. Aucun nouvel essai PostgreSQL, R2, fournisseur réel ou appareil natif n'est annoncé ici.
- Les régressions CH web sélectionnées ne remplacent pas une recette complète des QR-factures, archives, CHF, TVA et distributions natives.
- Les reprises conservées uniquement dans l'onglet sont perdues à sa fermeture ; le reçu durable conserve cependant le résultat serveur. Aucun POST n'est relancé automatiquement au rechargement.
- Les écritures de ce registre n'apportent aucun droit financier, abonnement, quota d'analyse ou autorisation d'envoi de mail.

## 7. Terminé dans ce périmètre

Registre multi-entreprise US, contrôle de droits courants, création atomique et idempotente, lecture autorisée, erreurs sûres, écran multilingue clair/sombre, purge d'identité et vérifications locales. Aucun changement de production, prix Stripe, région, données client ou artefact distribué.

## 8. Encore expérimental et suite

La verticale Support US reste expérimentale et fermée. Prochain incrément proposé : **H2a**, connecter une boîte Infomaniak vérifiée et importer explicitement ses PDF/images dans le coffre US existant, avec provenance privée et reçus stables. Réutiliser les transports communs `lib/support/infomaniak.ts`, sans appeler l'orchestrateur `mail-sync.ts` encore lié aux tables legacy. Le compteur de liste porte sur les threads ; la pagination doit être testée comme telle. Le transport actuel expose PDF/images/ICS, pas les pièces `.txt` ; ICS reste hors coffre fournisseur.

L'analyse demeure séparée, sous Automation, consentement, budget et approbation financière. Il reste à construire la connexion et sa révocation, le stockage chiffré contextualisé par entreprise, les reçus de provenance par message/pièce et la reprise archive→acquittement. Worker automatique, délégations par action, budget de classification générale US, tickets et workflows client/rendez-vous viennent ensuite. Aucun quota `supplier_invoice_extract` ne doit être emprunté pour le tri général.

Staging autorisé, fournisseurs réels, recette professionnelle comptable/fiscale, cycle commercial complet et distribution native restent nécessaires avant le pilote américain.
