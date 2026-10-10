# Livraison US Support — H2b, 10 octobre 2026

## 1. Résumé

H2b relie la consultation explicite Infomaniak US aux originaux fournisseurs existants. Un propriétaire ou administrateur choisit un PDF, PNG ou JPEG, confirme sa conservation et le retrouve dans le coffre Achats, actualisé après confirmation. Une réponse perdue se reprend avec la même commande ; une connexion remplacée ne détruit pas cette reprise. Le compte, l'entreprise, le rôle ou les droits perdus effacent les informations privées de l'onglet.

Base locale `1c2ba36`, implémentation `b568830a3ccb441fc95cedd7f81e0894b33c2ad8` (sans push). La gate `INTERNATIONAL_US_SUPPORT_MAIL_IMPORT_ENABLED` est fermée par défaut, en plus de H2a/H1/Core/ERP et de la disponibilité des originaux fournisseurs. Gestion US/USD doit être initialisé en schéma 4. Gestion et Support doivent être admis sur la même période SaaS effective. Aucun droit de messagerie n'est ajouté au rôle comptable.

L'import ne déclenche ni analyse, création de fournisseur/facture, écriture comptable, acquittement, classement, envoi ou worker. Il conserve un original et sa provenance privée ; les fonctions Automation restent séparées.

## 2. Fichiers créés

| Fichiers | Rôle |
| --- | --- |
| `lib/international/us-support-mailbox-import-contract.ts` | Commande et faits immuables, clés source/requête et validation des reçus. |
| `lib/international/us-support-mailbox-import-d1.ts` | Sources, alias d'acteurs et confirmations sous admission H1 réelle. |
| `lib/international/us-support-mailbox-import-provider.ts` | UID amont corroboré, manifeste, endpoint fixe, octets et deux observations bornées. |
| `lib/international/us-support-mailbox-import-server.ts` | Saga de conservation, autorité fraîche et reprises D1/PG/R2. |
| `lib/international/us-support-mailbox-import-bindings.ts` | Gates, stores réels, chiffrement et limite de requêtes. |
| `lib/international/us-supplier-document-lookup.ts` | Lookup PostgreSQL privé par empreinte binaire. |
| `lib/international/browser-us-support-mail-import-session.ts` | Commande exacte en mémoire, réponse bornée/scopée et reprise. |
| `components/account/us-support-mail-import.tsx` | Confirmation, reprise et succès FR/DE/IT/EN. |
| `app/api/international/workspaces/[organizationId]/support-mailbox/import/route.ts` | POST dédié à l'import explicite. |
| `lib/international/us-support-mailbox-import-{contract,d1,provider,server,bindings,composition}.test.ts`, `us-support-mailbox-import-test-fixture.ts`, `us-support-mail-import-ui.test.ts`, `us-supplier-document-lookup{,.postgres}.test.ts` | Contrats, vrais schémas locaux, frontières HTTP, transports et rendu. |
| Les deux migrations ci-dessous, `US-SUPPORT-MAIL-IMPORT-PLAN-20261010.md`, ce document et `docs/evidence/us-support-mail-import-20261010*` | Plan, livraison et preuves. |

## 3. Fichiers modifiés

- `app/compte/espaces/us/[organizationId]/page.tsx` : disponibilité H2b et lien vers les originaux depuis Support.
- `components/account/us-erp-workbench.tsx` : coordination des écritures, purge, rafraîchissement ciblé et navigation vers Achats.
- `components/account/us-supplier-documents.tsx` : rafraîchissement demandé après un import confirmé, sans analyse automatique.
- `components/account/us-support-{workspace,mailbox}-panel.tsx` : sélection des pièces, maintien de la reprise après déconnexion et indications adaptées à la gate.
- `lib/international/us-support-mailbox-bindings.ts` : export du membre H2a existant, sans changement de ses droits.
- `tests/us-supplier-documents-preview.tsx` : parcours réel workbench→coffre avec HTTP et données fictifs.
- `docs/internationalization/STATUS-20261009.md` : jalon H2b et étapes restantes.

Aucun fichier natif, code CH/legacy de traitement mail, ancienne migration, tarif ou abonnement n'est modifié.

## 4. Migrations proposées

`drizzle/0095_international_us_support_mail_import.sql`, générée localement avec Wrangler, ajoute trois tables append-only et leurs gardes. Les sources sont uniques par entreprise/registre/fournisseur/mailbox/folder/UID/part, indépendamment de la connexion, de la date et du contenu. Les faits immuables sont comparés ; une identité réutilisée avec d'autres faits est refusée. Les confirmations historiques relisent H1 mais n'exigent pas l'ancien secret. Limites pilote : 500 sources et 2 000 requêtes par entreprise.

`supabase/migrations/20261010024618_international_us_supplier_original_hash_lookup.sql`, générée avec Supabase CLI, ajoute seulement un RPC invoker à search_path vide, service-only, exploitant l'unicité existante des empreintes. La réserve, l'archive et les liens d'originaux restent les tables et fonctions existantes. Les fonctions, ACL, RLS et données CH fictives sont comparées avant/après dans les tests locaux.

Les migrations ont été exécutées uniquement en RAM : chaîne D1 réelle 0000–0095 et 21 migrations internationales PostgreSQL sur baselines legacy fictives. Aucune application hébergée ou désactivation de RLS. Retour arrière : fermer H2b, revenir au code précédent et conserver tables, reçus, réserves et objets ; aucun nettoyage compensatoire ou destructif.

## 5. Tests exécutés et résultats

Les résultats finaux, commandes, sélections et empreintes sont enregistrés dans `docs/evidence/us-support-mail-import-20261010.json`. La sélection inclut la régression H2a précédente et les neuf nouveaux fichiers, dédupliqués. Les relances ciblées se recouvrent et ne s'additionnent pas.

| Vérification | Résultat | Preuve |
| --- | --- | --- |
| Régression dédupliquée, 99 fichiers | **3 195/3 195**, zéro échec, skip, todo ou suite échouée | `.qa/us-support-mail-import/regression-final.json` et `selection-final.json` |
| Dont backend/contrat/D1 | 100/100 | `backend-final.json` |
| Dont composition HTTP→D1 réelle | 8/8, revérifiés dans la régression finale après annotations TypeScript | `composition-final.json` et régression |
| Dont RPC | 34 unités + 14 PostgreSQL local | `lookup-final.json` |
| Dont UI H2b | 57/57 ; le rapport UI 154 inclut aussi H2a/H1 | `ui-first.json` et régression |
| TypeScript global, lint typé ciblé (26 fichiers), marque | Codes de sortie 0 | `typecheck-final.log`, `lint-final.log`, `brand-final.log` |
| Build production | Code de sortie 0, « Build complete » | `build-final.log` |
| Navigateur, confirmation FR/DE/IT/EN | 24 cas, clair/sombre, 320/390/1440 px ; aucun débordement mesuré, focus sur le titre | `layout-results.json` et captures |
| Reprise/purge/droits + vrai workbench/coffre | Deux POST identiques, un original et une confirmation ; reprise après déconnexion ; purge Auth/refus ; coffre actualisé sans bouton en desktop/mobile | `interaction-results.json`, `workbench-results.json` |

Les rapports ciblés sont des instantanés et recouvrent la régression finale. Après suppression d'espaces sur deux lignes SQL vides pour le contrôle de diff, les 62 tests D1/composition ont été revérifiés avec succès (`sql-format-followup.json`), sans changement de comportement. Les premières erreurs de fixtures et de typage/lint restent conservées séparément. Les avertissements build sur la convention middleware et la classification statique des routes sont préexistants ; le build réussit, sans recette de serveur hébergé. Fermer uniquement la gate d'import purge H2b ; les métadonnées H2a encore autorisées restent consultables.

Les tests couvrent perte de réponse à chaque frontière, reprise après déconnexion, déduplication source/binaire/acteur, conflit de manifeste ou contenu, bytes corrompus, absence d'archive, droits/capacité/gates/session révoqués pendant les attentes, changement d'entreprise et absence d'effet financier/inférence/acquittement. Les diagnostics ne contiennent que opération/code/statut, sans secret ni contenu.

## 6. Risques identifiés

- D1, PostgreSQL et R2 ne constituent pas une transaction distribuée unique. La saga conserve des étapes durables et les vérifie avant confirmation. Les tests RAM ne prouvent pas la concurrence ou la disponibilité de l'infrastructure hébergée.
- Deux observations de métadonnées et une empreinte des octets ne constituent pas un snapshot atomique ou une signature du fournisseur. Aucun contrat UIDVALIDITY/ETag fort n'est établi. Un UID/manifeste ambigu est refusé.
- Seuls PDF/PNG/JPEG de 1 octet à 6 MiB sont importables. Un ICS reste une référence de consultation. Extraction PDF littérale seulement ; aucun OCR annoncé. Le coffre conserve ses limites existantes de 50 originaux/100 MiB.
- Une reprise non confirmée reste en mémoire de l'onglet, sans clé ni fichier. Recharger ferme cette mémoire, pas les traces durables. Pas de réconciliation indépendante, rétention/GC ou outil d'abandon sûr ajouté ici.
- Aucun fournisseur réel, Auth/Stripe sandbox réel, serveur distribué ou appareil physique n'a été testé dans ce jalon. Aucune conformité fiscale générale, certification ou validation native CH/US n'est revendiquée.

## 7. Fonctionnalités terminées

Le parcours local explicite et traduit, son raccord au coffre existant, la provenance privée, les reprises et les contrôles serveur sont implémentés dans le périmètre décrit. La version suisse, ses données et abonnements ne sont pas modifiés. Pas de publication, push, migration/gate hébergée, région déplacée ou traitement de données clientes.

## 8. Fonctionnalités expérimentales et suite

H2b demeure un pilote fermé jusqu'à une recette staging expressément approuvée. La prochaine verticale doit définir les délégations et quotas avant réception automatique/classification, puis les tickets, demandes clients et rendez-vous. Les devises/taxes/paiements clients complexes, les autres verticales ERP, le pilote hébergé et la distribution native US restent ouverts. L'objectif ERP international n'est pas déclaré terminé.
