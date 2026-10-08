# Zentra US — collaboration et invitations

9 octobre 2026. Phase C incrémentale, base `93aedd8f6820446f45d6fc70b4818e532e1f17df`. Livraison source isolée ; l'objectif ERP US complet reste ouvert. Le relevé machine des fichiers, hashes et essais est `docs/evidence/us-team-admission-20261009.json`.

## 1. Modifications et comportement

Une personne peut recevoir un lien privé pour un espace US, se connecter avec l'adresse destinataire confirmée, renseigner son prénom et son nom, puis rejoindre cet espace. L'entreprise, sa devise et son abonnement sont conservés : aucune nouvelle entreprise, licence ou offre n'est créée. Le lien de succès ouvre l'espace existant. Les droits des modules restent ceux de l'offre approuvée côté serveur.

Le panneau Équipe est disponible dans les réglages de l'espace et le workbench lorsque les trois gates Core/ERP US/Team sont activées. Il est indépendant d'un livre ERP initialisé. Le changement de vue préserve les six surfaces financières, leurs brouillons et opérations en attente. Les quatre langues, thèmes et contrôles tactiles réutilisent l'identité Zentra.

Le plafond provient de l'autorité SaaS US vérifiée ; propriétaire inclus, membres actifs et invitations valides réservées comptent ensemble. Owner gère les rôles non-owner ; admin gère seulement membre et consultation. Une acceptation applique profil/membership/réservation/reçu/audit dans le même batch D1. Une révocation invalide atomiquement la membership et ses sessions US des deux familles.

Le token CSPRNG de 32 octets n'est conservé qu'en hash côté serveur. Seule une première application confirmée peut rendre un lien en fragment. Une reprise rend le reçu sans nouveau lien ; la régénération explicite remplace l'ancien lien sans réserver une deuxième place. Le navigateur retire le fragment et garde le secret en RAM ; il ne le transmet pas au formulaire de connexion, au stockage navigateur, aux logs ou aux captures. Aucun e-mail n'est envoyé.

## 2. Fichiers créés

- `lib/international/us-team-contract.ts`, `us-team-validation.ts` et leurs tests : DTO, noms NFC, hash, rôle, corrélation et distinction contexte privé/authentification.
- `lib/international/us-team-store.ts`, `us-team-store.test.ts`, `us-team.migrations.test.ts`, `us-team.workerd.test.ts`, `us-team-test-fixture.ts` : stockage, gardes et fixtures strictement TEST.
- `lib/international/us-team-server.ts`, `us-team-server.test.ts`, `us-team-bindings.ts`, `us-team-bindings.test.ts` : handlers et provenance Auth/SaaS/appareil actuelle.
- `lib/international/browser-us-team-session.ts`, `browser-us-team-session.test.ts`, `browser-us-team-copy.ts`, `browser-us-team.browser.test.ts` : transport borné, reprises, UI et langues.
- `components/account/us-team-panel.tsx`, `.css`, `us-team-invitation.tsx`, `.css` : équipe et acceptation publique autonome.
- `app/api/international/workspaces/[organizationId]/team/route.ts`, `app/api/international/team-invitations/resolve/route.ts`, `accept/route.ts`, `app/invitation/us/page.tsx` : routes US distinctes.
- Migration `drizzle/0090_international_us_team_admission.sql`.
- Plan, livraison et relevé de preuves de ce jalon.

## 3. Fichiers modifiés

- `app/compte/espaces/us/[organizationId]/page.tsx` : réglage Équipe, gate et props du workbench. Aucun repli sur une entreprise CH.
- `components/account/us-erp-workbench.tsx` : vue Équipe facultative, fermée par défaut, sans démontage des canaux financiers.
- `docs/internationalization/STATUS-20261009.md` : progression locale et lacunes restantes.

Le site public publié, les anciennes migrations, les source/types métier CH et la copie native ne sont pas modifiés par ce jalon.

## 4. Migration, compatibilité et retour arrière

La migration a été créée par le CLI Wrangler local, puis testée dans SQLite et le vrai workerd/D1 local avec la chaîne `0000`–`0090`. Elle ajoute tête, commandes, invitations, profils, audit, index et gardes ; elle ne vide, ne supprime et ne réécrit aucune donnée existante. Les sessions/challenges et memberships historiques utilisés par les tests sont créés avant application de `0090` pour contrôler la compatibilité.

Le premier retour arrière est **logique** : fermer `INTERNATIONAL_US_TEAM_ENABLED`, revenir au code de base, conserver les tables, reçus et membres historiques. La découverte et les lecteurs US préexistants continuent de lire les memberships ; aucune rétrogradation de credential n'est nécessaire. Une remise à zéro physique ne fait pas partie de ce jalon. Avant une migration hébergée : copie vérifiée, essai staging, inspection des contraintes/index et accord utilisateur explicite. Aucun `apply --remote`, migration Supabase ou changement Stripe n'a été exécuté.

## 5. Tests réellement exécutés

Les résultats définitifs et leur portée sont consignés dans le relevé machine ; les tentatives échouées sont conservées dans `.qa/us-team/`. Les tests avec Auth, catalogue et paiements injectés sont identifiés comme fictifs. Les essais workerd utilisent le vrai moteur D1 local, sans utilisateur Supabase hébergé ni paiement Stripe réel.

| Contrôle ciblé | Résultat exécuté | Portée |
| --- | --- | --- |
| Contrat et validation | 97/97 | Structure, noms, rôles, quota de places et contexte privé |
| Bindings | 47/47 | Provenance Auth/SaaS/session avec fournisseurs TEST injectés |
| Store et migration SQLite | 39/39 | Contraintes réelles, reprises, dernière place, audit et invalidation des sessions |
| HTTP | 18/18 | Handlers avec SQLite, identité et preuve de paiement fictives |
| Transport final | 37/37 | Reprise exacte, perte d'accès et corrélation du nouvel ID de régénération ; un cas passe par HTTP/SQLite réel |
| Compatibilité partagée CH | 87/87 | Tests web Auth, Checkout/contrat/webhook Stripe et fournisseur ; ni QR/TVA native ni paiement live certifiés |
| Navigateur | Deux exécutions ciblées, chacune 1/1 | 24 captures FR/DE/IT/EN, clair/sombre, desktop et 320 px avec texte à 200 % ; complément Auth/copie distinct sans nouvelles captures |

La suite internationale globale a exécuté **5 276 tests réussis, 2 échoués et 36 non exécutés, sur 138 fichiers**. Quatre fichiers rencontrent `workerd spawn UNKNOWN` au lancement : deux assertions échouent et 21 cas ne démarrent pas ; 15 autres cas sont conditionnels/opt-in. Une relance ciblée des quatre fichiers garde le même blocage. Cette suite reste donc **en échec**, même si la première exécution workerd du nouveau store avait réussi ses 11/11 tests sur les mêmes sources de stockage. Les deux preuves et les tentatives échouées sont conservées ; la dernière tentative ne remplace pas un échec par un résultat ancien.

Le relevé final distingue les essais ciblés des résultats globaux et déduplique fichier/nom/ordinal d'occurrence dans l'ordre réel des exécutions. Plusieurs cas paramétrés ont le même titre : leur ordinal est conservé, avec ordre de définition stable supposé pour ces cas inchangés, afin de ne pas les fusionner. Les répétitions ne sont jamais additionnées comme de nouveaux tests. Les 24 captures précèdent les derniers correctifs fonctionnels Auth/copie/corrélation, qui ne changent pas les styles ; elles ne prouvent pas une nouvelle inspection visuelle de ces correctifs.

TypeScript global et lint syntaxique des 25 fichiers TS/TSX de ce jalon : zéro erreur. Les vérifications de marque, `git diff --check` et la compilation de production Vinext passent (heap Node limité à 1 024 Mo). Le build signale encore sa limite connue de classification statique des routes, sans échec de compilation. Certaines tentatives de lint avec types sont également bloquées au lancement de `tsgolint` sous Windows (`UNKNOWN/-4094`) ; les réussites ciblées Core/UI ne constituent pas une réussite globale avec types. Les empreintes définitives sont enregistrées séparément dans le relevé machine.

## 6. Risques et limites

- Aucun essai hébergé, aucune compilation/distribution native, aucun paiement ou e-mail réel. Une membership locale n'est pas une preuve de synchronisation Windows/Mac/iPhone en production.
- La session navigateur est revérifiée avant/après les attentes et mutations. Supabase Auth et D1 ne forment pas une transaction distribuée ; aucune atomicité interservices n'est revendiquée. La session appareil conservée est également corroborée dans le batch D1.
- Les rôles restent immuables et une révocation reste irréversible dans ce jalon. Pas de transfert owner, changement de rôle, réactivation ou suppression silencieuse. Un propriétaire historique sans prénom/nom garde un nom non renseigné.
- Une réponse initiale perdue ne permet pas de récupérer le token : régénérer le lien explicitement. Après connexion depuis une invitation, rouvrir le lien original. Une erreur d'identité efface le secret au lieu de le transporter entre comptes.
- Les profils et contextes de commande privés contiennent des données personnelles nécessaires à la preuve ; l'audit diagnostique n'en contient pas. Politique de rétention, droits de suppression et résidence réelle des données restent à examiner avant lancement commercial.
- Plafond structurel de 1 000 places, payloads et lectures bornés : cela ne mesure ni la capacité de 150 entreprises, ni une charge soutenue. Historique non paginé/archivé dans ce premier jalon.
- Le lint avec types peut être bloqué au démarrage par Windows ; un lint syntaxique réussi n'en constitue pas un remplacement équivalent.

## 7. Terminé dans ce jalon

Parcours US de bout en bout local, invitations sans secret persisté en clair, places réservées, noms explicites, membership liée à l'espace existant, permissions, CAS et idempotence, révocation des sessions, vérifications Auth actuelles sur succès/erreur, traductions, thèmes et navigation préservant les travaux financiers. Les tests de contraintes incluent propriétaires protégés, UUID compatibles, mauvaise identité/entreprise, expiration, réponse perdue et dernière place concurrente.

## 8. Expérimental et suite

Les nouvelles routes restent fermées par défaut et non publiées. Le jalon rend la collaboration testable ; il ne termine pas Zentra US. Restent notamment : staging à deux identités réelles, propagation des sidecars/reconnexion, observation fiscale TEST fiable et raccord du gateway actuellement null, parcours commercial USD et renouvellement, messagerie/originaux Support US, commandes/avoirs/récurrence/acompte et validation professionnelle des rapports. Aucun taux fiscal américain, Price ID live ou promesse de certification n'a été inventé.
