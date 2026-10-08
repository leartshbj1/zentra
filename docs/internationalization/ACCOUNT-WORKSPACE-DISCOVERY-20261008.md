# Choix des espaces CH et US — plan de tranche

Base : `002854a923b764d7b729802452babfe824a96d00`. Travail local, aucune publication ni migration de production.

## Contrat après revue

Créer une surface « Mes espaces » indépendante du modèle de licences CH. La découverte est une lecture metadata-only liée au compte Auth ; elle ne crée ni droit ni entreprise. Elle conserve les espaces prêts expirés dans la sélection mais l'ouverture US vérifie les droits frais, les membres, la session et les flags. Les intentions `reserved` ou `postgres_confirmed` ne sont pas des espaces ouverts.

Le DTO public n'a que `{organizationId, name, edition, role}`. Aucun abonnement, preuve, reçu, configuration ou identifiant fiscal n'est communiqué. L'organisation US vient de l'admission serveur exacte, son membre appelant et son propriétaire actifs. L'édition CH historique ne doit pas être réinterprétée en US, ni l'inverse.

Ajouter GET navigateur `/api/account/workspaces`, `/compte/espaces` et une destination expérimentale `/compte/espaces/us/[organizationId]`. Refuser Authorization/Bearer sur cette nouvelle lecture avant SQL. Revalider la session après la lecture. Aucune écriture métier, paiement, licence ou PG.

Préserver `membershipsForUser`, `/me`, device approve/poll, claim, licence, abonnement, équipe, sauvegardes et les URLs CH. Ne pas injecter des espaces US dans les listes CH. Le shell expose Mes espaces ; dans le sous-parcours US il n'offre que les destinations globales sûres et aucune destination métier CH. Le choix est porté par l'URL ; aucune préférence ne devient un grant.

## Fichiers prévus

- `lib/account-workspaces.ts`, tests et nouveau GET.
- Pages Mes espaces et US expérimental ; petit composant de sélection bilingue/quatre langues, sans traduire les noms d'entreprises.
- `components/account/account-shell.tsx`, styles additionnels et intégration limitée de l'accueil compte.
- Rapport de tests et preuve locale.

## Validation requise

Compte mixte, rôles, pending/tiers exclus, DTO sans fuite, Bearer refusé avant SQL, session modifiée pendant lecture, zéro mutation, expiration/révocation, flags désactivés et absence de schéma sans fallback. Tests de navigation CH conservée et page US ne consultant jamais teamSeats/licences/journey. Typecheck, lint des fichiers changés, build et régression adaptée ; contrôle local des formats/mobilité sans prétendre à une recette physique/live.

## Limites

La page US est un point d'entrée expérimental explicite, pas l'ERP complet ni un onboarding live. Un espace absent ne doit pas être fusionné automatiquement avec une ancienne entreprise. L'admission, le paiement Stripe et l'installation native US restent des tranches distinctes. Une publication future doit préserver le site public 354, situé dans son autre checkout.

## Livraison locale et vérification

### Résultat

Une surface indépendante « Mes espaces » découvre les entreprises CH historiques et les entreprises US finalisées du même compte Auth. Les noms identiques ne fusionnent pas les entreprises : les liens portent leurs IDs et leur édition. Le DTO public est limité aux quatre champs annoncés. Une entreprise expirée ou dont l'autorité d'abonnement est révoquée reste visible à son membre actif ; la page US revérifie les droits et refuse l'accès.

Le compte mixte demande un choix avant le parcours CHF. Le sélecteur CH et ses URLs restent propres au modèle existant. La page US n'offre aucun lien de sauvegarde, licence, équipe ou abonnement CH ; ses réglages personnels restent dans sa destination et sa navigation mobile. La page annonce explicitement la préparation du parcours US, sans faux bouton vers un ERP terminé. Les nouvelles copies sont disponibles en FR/EN/DE/IT ; les noms d'entreprises ne sont pas traduits.

Le layout n'envoie plus les IDs d'abonnement CH dans les props du shell. Le serveur vérifie à nouveau l'acteur après ses lectures ; si la session a changé, il refuse également l'enfant déjà rendu. Les flags sont vérifiés après les attentes Auth. Les préférences d'apparence sont lues avant l'autorisation et la session finales. Le lien clavier vers le contenu cible maintenant un élément focalisable.

### Fichiers créés

- `app/api/account/workspaces/route.ts`
- `app/compte/espaces/page.tsx`
- `app/compte/espaces/us/[organizationId]/page.tsx`
- `components/account/workspace-picker.tsx`
- `docs/internationalization/ACCOUNT-WORKSPACE-DISCOVERY-20261008.md`
- `lib/account-workspace-copy.ts`
- `lib/account-workspace-entry.test.ts`
- `lib/account-workspace-navigation.test.ts`
- `lib/account-workspace-navigation.ts`
- `lib/account-workspace-pages.test.ts`
- `lib/account-workspaces-route.test.ts`
- `lib/account-workspaces.test.ts`
- `lib/account-workspaces.ts`
- `scripts/qa-account-workspace-regression.mjs`
- `scripts/qa-account-workspaces.mjs`
- `docs/evidence/account-workspace-discovery-20261008.json`

### Fichiers modifiés

- `app/compte/account.css`
- `app/compte/layout.tsx`
- `app/compte/page.tsx`
- `components/account/account-shell.tsx`

### Migration et retour arrière

**Aucune migration ajoutée ni appliquée** dans cette tranche. La découverte US nécessite 0085–0087, déjà éprouvées localement dans les phases précédentes. Flags fermés, le lecteur ne consulte aucune table US ; flags ouverts mais schéma manquant, il refuse la liste par une erreur 503 sans résultat partiel. Les 107 SQL historiques du commit `002854a923b764d7b729802452babfe824a96d00` conservent leur blob Git canonique.

Retour arrière fonctionnel : conserver les flags fermés et les tables/audits, retirer les nouvelles destinations du parcours ; ne jamais fusionner ou reclasser les espaces US en CH. Les modifications ne changent pas les données métier ou abonnements.

### Tests exécutés

| Contrôle | Résultat | Portée |
| --- | --- | --- |
| Régression sélectionnée, 79 fichiers | **2 105 passés, 0 échec, 63 ignorés** | Fondation CH/US, transport, autorité et nouveaux tests ; pas tout le dépôt |
| Cinq fichiers nouveaux, rejoués après finalisation du rendu | **80 passés** | Inclus dans le total précédent, ne pas additionner |
| Reader SQLite | 19 tests, inclus | Chaîne locale complète de 88 migrations |
| Route GET | 15 tests, inclus | Session et lecteur simulés, DTO, origines, Bearer refusé et zéro mutation |
| Pages, index, layout et navigation | 46 tests, inclus | Contrats React/SSR avec dépendances Auth simulées |
| QA navigateur local | **24 vues passées**, 8 captures | 4 langues × 2 thèmes × 3 largeurs ; 8 contrôles supplémentaires de texte forcé à 200 %, focus et liens corrects |
| Typecheck global | Passé | TypeScript |
| Lint des 17 fichiers source/tests/scripts changés | Passé | Règles préservées, pas de lint global |
| Build production | Passé | Bundle local, aucun déploiement |
| SQL historique | 107 / 107 préservés | Comparaison canonique Git |

Le navigateur utilise le vrai shell et le vrai picker React rendus en HTML, avec CSS account + Apple account, un token de police système et données fictives. Auth, déconnexion et choix de langue sont simulés. Ce contrôle ne prouve ni la session live, ni la latence Supabase, ni les appareils natifs, ni une recette de toutes les pages du site. Il n'autorise aucune affirmation de capacité multi-appareils/charge/production. Les sélections se chevauchent.

Les vérifications ont fait corriger le postflight flags/session, le refus des enfants de l'ancien acteur, les URLs US malformées, le focus clavier et la séparation entre exceptions de lecture et rendu React ; aucun test n'a été retiré ni règle de lint désactivée. Rapport machine : `docs/evidence/account-workspace-discovery-20261008.json`.

### Terminé et encore expérimental

Terminé localement : discovery Auth en lecture seule, projection stricte, choix par édition/ID, barrières fraîches et UI claire/multilingue/mobile. Le modèle CH de licences et d'abonnements n'est pas utilisé pour accorder l'accès US.

Expérimental/non publié : ce sélecteur, l'admission US, les catalogues USD, la création et les installations US. Aucun vrai paiement, prix US, session native, migration ou déploiement de production n'est effectué. L'association vérifiée par tests est une association de métadonnées autorisées, pas la preuve d'un compte réel connecté sur Windows/macOS/iOS.

### Prochaine étape du cycle métier US

Réutiliser les GET/POST ERP et leurs routes de révision/changements pour un workbench navigateur séparé. Un client/devis peut utiliser le moteur persistant existant ; l'émission reste bloquée par le binding fiscal `null` et l'absence de writer vendeur US dédié. Les données fiscales et autorisations ne doivent pas venir du navigateur. Le vendeur devra avoir une route internationale owner-only et stockage/CAS auditables ; ne pas appeler le profil device/CHF legacy.

Avant ce branchement, fermer le cas de rejeu ERP qui retourne un reçu sans revalidation après sa lecture, et vérifier les flags avant commit/projection. Le cycle comptable doit conserver la méthode : en accrual la facture produit son journal, en cash il faut son paiement. Une démonstration fictive ne remplace ni admission Stripe sandbox vérifiée ni staging persistant complet ni prestataire fiscal réel.

Le site orienté résultats déjà publié demeure indépendant (Sites 354). Toute future livraison US doit rapprocher cette branche avec le site public à jour et le native 1.90.15, sans les écraser par ce checkout ancien.
