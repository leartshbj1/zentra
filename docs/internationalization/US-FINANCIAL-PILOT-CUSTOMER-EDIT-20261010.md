# Pilote US — correction des fiches clients V5

10 octobre 2026. Livraison locale privée TEST. Plan préalable commité `7124c32`, clarification documentaire `fae8b0f`. Implémentation `ceaed1c1d56cb261582f31822b117ca21c6622c4`. [Preuve structurée](../evidence/us-financial-pilot-customer-edit-20261010.json), SHA256 `8d46761285f833d92f1deb4fe5ac9ac68cfb396b755131ad71ecd89558378f67`. Ce jalon poursuit l’objectif international ; il ne constitue pas une mise en production de Zentra US.

## 1. Résumé des modifications

Un client existant s’ouvre depuis le registre, avec ses coordonnées et conditions préremplies. L’utilisateur modifie les champs, compare les valeurs avant/après, puis confirme explicitement. La fiche garde son ID. Le formulaire et la revue utilisent la session financière commune et son verrou ; aucun autre timer, store ou livre n’est créé.

Le serveur impose le tenant et n’effectue jamais d’upsert pour une correction inconnue. `update_customer` utilise le `save_customer` natif déjà présent, sous la clé distincte `pilot:commercial:update_customer:<UUID>`. Une reprise durable exacte précède la vérification vivante d’existence, après admission et corroboration. Les trois commandes commerciales antérieures conservent leur protocole.

L’approbation disparaît après une modification de la saisie, une mutation locale commune, un F nouveau ou une révocation. Le formulaire conserve ses champs lors d’une actualisation ordinaire ; une nouvelle revue lit le client courant avant de proposer les différences. Les réponses 409/422 sans preuve de phase, réseau/503 ou succès malformé conservent la même demande update en attente. La reprise utilise exactement ses UUID, corps et F initiaux.

## 2. Fichiers créés

- `app/api/international/workspaces/[organizationId]/financial-pilot/customers/[customerId]/route.ts` : GET mince, détail client fermé au F demandé.
- `docs/internationalization/US-FINANCIAL-PILOT-CUSTOMER-EDIT-PLAN-20261010.md` : plan préalable.
- `docs/internationalization/US-FINANCIAL-PILOT-CUSTOMER-EDIT-20261010.md` : ce relevé.
- `docs/evidence/us-financial-pilot-customer-edit-20261010.json` : inventaire, empreintes, résultats et limites.

Les scripts, captures, exports de recette, tentatives et logs restent ignorés sous `.qa/us-pilot-customer-edit/`. Les contrôles loopback n’existent dans aucune route produit.

## 3. Fichiers modifiés

Quatorze sources de code/test, sans CSS nouveau :

- `lib/international/us-financial-pilot-commercial.ts` et `.test.ts` : intention, validation, mapping, reçu et namespace.
- `lib/international/us-financial-pilot-commercial-projection.ts` et `.test.ts` : détail client fermé, ID/tenant/F/L et invariance des snapshots.
- `lib/international/us-financial-pilot-commercial-server.ts` et `.test.ts` : admission, contrôle d’existence hors replay, détails et fence final.
- `lib/international/us-financial-pilot-commercial-bindings.test.ts` : délégation de la route et gates inchangées.
- `lib/international/us-financial-pilot-commercial.postgres.test.ts` : ancienne recette32 conservée et recette cumulative34 distincte.
- `lib/international/browser-us-financial-pilot-commercial-input.ts` et `.test.ts` : capture exacte, nulls et revue pure gelée.
- `lib/international/browser-us-financial-pilot-session.ts` : détails/revues possédés, génération/mutation/F, verrou et reprise.
- `lib/international/browser-us-financial-pilot-commercial.test.ts` : intégrations avec vrais handlers/kernel et memory port.
- `lib/international/browser-us-financial-pilot-commercial-copy.ts` : copie FR/DE/IT/EN.
- `components/account/us-financial-pilot-commercial.tsx` : formulaire, comparaison, approbation, états d’attente et purge.

`docs/internationalization/STATUS-20261009.md` reçoit un état en tête, avec conservation des octets précédents. Total prévu : 15 sources de code/test et quatre documents. Parent, bindings productifs, Party général, store/kernel, banque et SQL restent inchangés.

## 4. Migrations proposées

Aucune migration nouvelle. Le remplacement/no-op `save_customer` existe déjà dans l’append commercial V5. La recette locale éprouve les 34 migrations existantes jusqu’à `20261010155848_international_us_financial_pilot_bank_test_v1`, sans changer leurs octets, grants ou RLS.

Aucune migration hébergée, activation automatique, production, région, compte client, offre/Price ID Stripe ou source CH modifié. Retour arrière : fermer les gates TEST et retirer la nouvelle intention/route/UI ; conserver événements et reçus V5 compris par le store précédent. Aucune suppression, annulation durable ni réouverture ERP4.

## 5. Tests exécutés et résultats

Arbre validé de **3 644 fichiers**, SHA256 `5fdb6f96e55ce214240a40a163d58c1d13f9c536ca18ec5aee7fed9ab19dc3c6`. L’empreinte porte sur les octets de travail triés, pas les blobs Git normalisés (`core.autocrlf=true`). Les sorties enregistrent les sources avant/après et leur stabilité.

| Contrôle | Résultat effectivement exécuté |
| --- | --- |
| TypeScript global, sans cache incrémental | sortie 0 |
| Lint typé des 15 sources, avertissements refusés | sortie0 |
| Marque et build production | sorties 0 |
| Ciblés 7 fichiers, PostgreSQL sérialisé inclus | **272/272**, zéro échec/pending/todo |
| Régression sélectionnée 203 fichiers | **6 709/6 709**, zéro échec/pending/todo ; 811323ms |
| Recette navigateur réelle et parsing de ses preuves | **20/20 assertions**, zéro échec |
| Revues statiques croisées | aucun défaut bloquant trouvé ; complément sur la fixture candidate2, pas une exécution indépendante |

Les totaux se recoupent et ne s’additionnent pas. Les 203 fichiers antérieurs sont conservés ; cette sélection inclut les contrôles CH de cash VAT, Auth, Stripe et Support, mais ne représente pas toutes les suites du repository. Les 165 tests backend hors PG et 299 tests navigateur/transport de travail sont des contrôles recoupants, avec leurs propres sources et logs.

La première recette ciblée a passé271/272. Son seul échec concernait la préparation du client hors page : les26 commandes de fixture avaient séparé l’horodatage de l’acteur capturé par la fondation et celui de la promotion. La sécurité a correctement refusé `financial_authority_changed`. Seul ce cas de test a changé : le même acteur frais est capturé pour sa fondation et sa promotion, avec revalidation vivante conservée. Sources et preuves candidate1 sont archivées ; qualité/ciblés/régression finale portent sur candidate2. Aucun contrôle produit n’a été assoupli.

PostgreSQL : même ID, nulls explicites, no-op F+1, client hors première page, unknown/foreign sans upsert, create/update au même UUID sans faux replay, conflit d’un même update key avec autre corps/F, révocation pendant lecture, fence après paiement tiers, reprise historique après réponse perdue et paiement tiers, fermeture/réouverture NodeFS réelle. Le livre mixte comporte émission, achats/règlement, avoir/encaissement, écriture manuelle et rapprochement. L/B, journaux, soldes, numéros et completion bancaire restent inchangés par la correction client.

Les devis et factures existants gardent leurs snapshots client ; un nouveau devis utilise la correction, un ancien ne l’adopte que lors d’une sauvegarde explicite. Les snapshots complets validés d’export facture PDF et leur sérialisation interne de valeurs sont conservés avant/après. La comparaison ne normalise que les marqueurs F courants nommés (`snapshot.revision`, `selector.revision`, fait financialRevision et exactement deux lignes internes). Aucun CSV facture public ni rendu PDF n’est revendiqué par cette comparaison. Les anciens alias de recettes compta/banque sont restaurés octet pour octet après chaque exécution.

Navigateur : vrai composant React StrictMode, session/handlers/kernel, Auth/D1/tax fictifs et requêtes memory port sérialisées. Réponse perdue après append, reprise aux mêmes octets sans doublon, modification tierce automatiquement observée, nouvelle revue du client courant, vrai409 après commit sous-jacent et rechargement explicite sans append supplémentaire ont été effectués. Le bouton de rechargement était désactivé avant acceptation de l’avertissement, puis activé ; il ne promet pas l’annulation d’un commit serveur. Les données et formulaires disparaissent du DOM après refus d’accès.

Contrôle groupé FR/DE/IT/EN, clair/sombre et320/390/1280px : aucun débordement observé dans les vues échantillonnées, adresses longues et champ effacé lisibles, actions mobiles44/48px, contour clavier3px. Ce n’est pas le produit cartésien de tous les états/langues/tailles. Les données fictives et le pied QA anglais ne sont pas traduits. Les logs warn/error enregistrés sur cet onglet de recette sont vides. Deux assertions initiales de preuve attendaient « Reload workspace » au lieu du vrai libellé « Reload the workspace » ; seules ces attentes ont été corrigées, draft conservé (18/20 puis20/20).

Documentation Supabase actuelle consultée le 10 octobre : [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) et [changements PostgreSQL 15.19/17.11](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes). Ce jalon conserve les ports, grants et RLS existants ; aucune compatibilité de la version hébergée n’est revendiquée sans requête sur cette instance. Sources et limites archivées dans la preuve.

## 6. Risques identifiés

La correction des coordonnées n’actualise pas silencieusement les documents déjà créés. La nouvelle fiche est conservée dans l’événement V5 privé avec son acteur ; l’état antérieur reste reconstructible depuis l’historique. La comparaison before/after appartient à la revue de l’utilisateur, sans journal financier supplémentaire. Le protocole conserve ses plafonds ; la pagination n’étend pas le budget du livre.

Une réponse incertaine peut rester bloquante même après un vrai refus CAS sans reçu : sa phase n’est pas prouvée au client. Reprendre ou recharger explicitement, puis relire avant une nouvelle demande. Les demandes et brouillons demeurent en RAM. Aucun historique CRM, fusion, suppression ou résolution automatique de conflit n’a été ajouté.

PGlite sérialisé ne prouve pas charge, crash, multiconnexion ou admission hébergée. Les captures navigateur ne prouvent pas une app native iPhone/macOS. Le reçu déjà validé peut encore résoudre sa promesse lors d’un stop déclenché par la publication finale commune ; les guards/purge de l’UI empêchent sa réadoption, sans prétendre annuler toutes les promesses communes.

## 7. Fonctionnalités terminées

Dans le pilote privé : lecture individuelle au F demandé, modification des huit champs d’un client existant, effacement des facultatifs, comparaison before/after, approbation explicite, détection de changements, protection des documents historiques, reprise exacte, purge d’accès et interface quatre langues responsive clair/sombre. Aucun nouveau service externe ou changement de règle fiscale n’a été introduit.

## 8. Fonctionnalités expérimentales et suite

Le pilote ERP US complet demeure en développement. Provisioning/admission hébergés et natifs, fournisseur fiscal réel et validation professionnelle, cash basis, clôture annuelle, workflows Support/Automation/originaux, commandes/projets avancés, exploitation et distribution restent ouverts. Ni certification US GAAP ni conformité exhaustive des cinquante États n’est annoncée.

Prochaine verticale recommandée après un plan préalable : PDF d’un devis sur le même pilote, en réutilisant le moteur d’export existant. Il faudra distinguer le snapshot client historique de l’identité vendeur actuelle capturée/revalidée ; aucun vendeur ne doit être inventé ou repris d’une autre facture. L’objectif international reste actif.
