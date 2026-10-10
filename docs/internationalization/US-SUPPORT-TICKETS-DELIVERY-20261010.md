# Livraison US Support — H3b, 10 octobre 2026

## 1. Résumé des modifications

Base locale `412fdc0`, implémentation `80077ff83ee701a1424f19d0ca2e29f16fdce0ed`, branche `codex/international-runtime`. Cette verticale complète la classification H3a par des tickets partagés, des corrections humaines, des affectations et un historique durable. Elle reste locale et fermée par défaut. Le site CH publié, ses abonnements et les applications natives distribuées ne sont pas modifiés.

Un ticket est issu d'une analyse H3a réellement terminée. Le serveur relit la source, le grant, le dispatch, la décision et leurs empreintes. Une source identique conserve son ticket même si une autre recette ou un autre acteur en demande la création ; cette reprise ne remplace pas une correction humaine. Le ticket ne conserve ni sujet, ni corps, ni pièce jointe d'e-mail. Il affiche le numéro du message et la date de création du ticket ; les heures de suivi sont explicitement en UTC.

Propriétaires et administrateurs corrigent catégorie, priorité et langue, affectent, changent le statut et définissent les règles. Un membre ne peut changer que le statut d'un ticket qui lui est encore attribué. Comptables et lecteurs consultent. Une règle automatique ne vise qu'un membre, administrateur ou propriétaire actif de la même entreprise, et exige une décision sans motif de vérification avec chacun des trois scores au-dessus du seuil effectif. Une règle nouvelle ne réaffecte pas les anciens tickets. Il n'y a ni envoi d'e-mail, ni opération financière, ni création fournisseur ou rendez-vous dans ce service.

Le raccord optionnel à la fin/reprise H3a utilise une commande stable. Une confirmation perdue peut être reprise à l'identique sans nouvel appel au modèle. Les erreurs asynchrones du raccord sont désormais attendues et traduites par le handler ; une réponse rejetée ne s'échappe plus de son traitement d'erreur.

## 2. Fichiers créés

- `lib/international/us-support-ticket-contract.ts`, `us-support-ticket-d1.ts`, `us-support-ticket-server.ts`, `us-support-ticket-bindings.ts` : contrats stricts, preuves privées, reçus, CAS, autorisations et routes.
- `lib/international/browser-us-support-tickets-session.ts`, `components/account/us-support-tickets.tsx` et `.css` : suivi compact, détails à la demande, règles séparées, quatre langues et thèmes existants.
- `app/api/international/workspaces/[organizationId]/support-tickets/{route.ts,head/route.ts,routing/route.ts}` : lectures privées, tête compacte et mutations.
- `lib/international/us-support-ticket-test-fixture.ts`, suites `us-support-ticket-{contract,d1,server,bindings,composition}.test.ts`, `us-support-triage-ticket-integration.test.ts` et `us-support-tickets-ui.test.ts` : tests locaux et données entièrement fictives.
- `drizzle/0097_international_us_support_tickets.sql`, plan, cette livraison et preuves sous `docs/evidence/us-support-tickets-20261010*`.

## 3. Fichiers modifiés

- `lib/international/us-support-triage-{server,bindings}.ts` : raccord optionnel de ticket, reprise d'une analyse terminée, erreurs asynchrones et diagnostic protégé.
- `components/account/us-support-workspace-panel.tsx`, `us-erp-workbench.tsx` : panneau indépendant d'une boîte encore connectée et purge coordonnée des données privées.
- `app/compte/espaces/us/[organizationId]/page.tsx` : disponibilité déterminée côté serveur pour les deux accès Support/Gestion.
- `lib/account-workspace-pages.test.ts` : vérification du raccord des capacités réellement admises.
- `tests/us-supplier-documents-preview.tsx` : scénario synthétique avec les vrais composants et transports, sans serveur/provider réel.
- `docs/internationalization/STATUS-20261009.md` : avancement et verticales restantes.

## 4. Migration et configuration proposées

La migration **additive D1 0097**, générée avec Wrangler 4.92.0, ajoute six tables : têtes, commandes, tickets, révisions, règles et audit. Les commandes et révisions sont immuables, liées par des clés composites entreprise/espace et des clés étrangères différées. Les triggers corroborent l'autorité H1 payée, le rôle actuel, la session native 4, la source H3a terminée, le CAS et la destination actuelle. Les preuves Auth et commerciales demeurent des entrées serveur de confiance ; la base n'authentifie pas seule un contexte arbitraire.

La gate `INTERNATIONAL_US_SUPPORT_TICKETS_ENABLED` exige aussi Core, ERP US et Support H1, mais pas H2a, une clé de modèle courante ou Automation pour consulter/corriger l'historique. Chaque opération recontrôle droits, session, rôle, période et gate. Aucune gate hébergée n'est activée.

Les plafonds **du pilote** sont 500 tickets par entreprise, 100 révisions appliquées par ticket (20 dernières affichées), 1 000 révisions de règles et 52 000 commandes par entreprise. Un alias de création garde son reçu/audit global, sans consommer une révision ni le plafond de corrections du ticket. La liste est paginée par 25 et ordonnée de la création la plus récente à la plus ancienne. Ces plafonds ne constituent pas une capacité commerciale mesurée ni une politique de rétention finale.

Retour arrière : fermer la gate, revenir au code précédent et conserver tables, reçus et audit. Aucune suppression de données, modification Supabase/RLS/région ou migration hébergée n'est effectuée. Une application en production demande l'approbation explicite prévue dans la mission.

## 5. Tests exécutés et résultats

La régression finale passe dans **114 fichiers : 3 715 tests réussis, zéro échec, skip, todo ou suite échouée**. Elle comprend les 238 tests des sept nouvelles suites H3b, les 65 tests de raccordement des pages de compte (dont 27 nouveaux), la chaîne D1 jusqu'à 0097 exercée aussi par workerd, et les 14 tests PostgreSQL d'originaux exécutés avec PGlite. Ces sous-ensembles sont inclus dans 3 715, ils ne s'y ajoutent pas. Aucun avertissement de terminaison workerd n'apparaît dans ce lancement.

TypeScript global, lint typé sans avertissement sur les 24 fichiers TS/TSX touchés, contrôle des actifs de marque et compilation de production : **codes de sortie 0**. La compilation conserve les notices existantes sur la convention middleware, les temps de plugins et la classification statique des routes vinext ; elles ne constituent ni une validation hébergée ni une erreur masquée.

Les 24 confirmations visuelles couvrent FR/DE/IT/EN, clair/sombre, **320/390/1 440 pixels effectivement mesurés**, sans débordement, avec focus dans le suivi et boutons/listes/sommaires de 44 pixels au minimum. Le contraste mesuré à 390 pixels dépasse 5,33:1 pour les textes et contrôles actifs vérifiés ; ce relevé n'est pas un audit d'accessibilité complet. Un relevé intermédiaire avait répété la largeur 390 au lieu de changer le viewport de l'onglet contrôlé. La matrice finale a été recommencée après correction du contrôle de recette, sans nouvelle modification de l'application.

Huit observations interactives confirment la reprise exacte liée au ticket initial, la préservation des autres brouillons, l'absence de faux conflit après sa propre confirmation, le repli des détails, le changement distant visible sans bouton au cycle nominal de trois secondes, la revue explicite avant correction, l'enregistrement des règles et la purge après perte d'accès. Elles utilisent la vraie interface et les transports avec un scénario HTTP fictif, distinct de l'intégration SQLite des vrais handlers.

Les résultats définitifs, commandes, sélections et empreintes sont consignés dans `docs/evidence/us-support-tickets-20261010.json`. Les essais intermédiaires et leurs échecs restent dans `.qa/us-support-tickets/` ; ils ne sont pas transformés en réussites.

Les tests couvrent les cinq rôles, les autres entreprises, les révocations, les périodes/Price IDs distincts, les confirmations perdues, la déduplication inter-recettes, l'intégrité de provenance, les courses CAS et les règles vers une cible révoquée. L'intégration utilise les vrais handlers H3a/H3b et le store D1 sur SQLite, avec Auth, boîte et classifieur fictifs. La chaîne des migrations est aussi exercée par workerd local. Les tests PostgreSQL existants utilisent PGlite local, sans accès au projet hébergé.

Le menu public demandé a été réinspecté séparément sur `https://zentraapp.ch/` : publication antérieure version 355, contour/rayon, affichage mobile et fermeture Échap observés. Les captures `public-menu-*-live.jpg` sont une preuve en lecture seule de cette publication existante, pas une publication H3b.

## 6. Risques identifiés

- La recette locale ne prouve pas Auth/D1/PostgreSQL hébergés, la latence réseau réelle, la précision de JEV ou la capacité de 150 entreprises simultanées.
- Le suivi en mémoire du navigateur n'est pas une file offline persistante : fermer ou recharger l'onglet efface la commande incertaine. Aucun nouveau requestId n'est substitué automatiquement à un résultat ambigu.
- Le polling nominal de trois secondes vérifie une tête compacte. Il recharge uniquement les pages déjà consultées quand ticket ou équipe ont changé ; il ne s'agit pas d'un flux WebSocket ni d'un delta par champ.
- Le texte et les pièces jointes ne font pas partie des tickets. La source amont garde les limites d'observation H3a, sans garantie UIDVALIDITY/ETag transactionnelle nouvelle.
- Une correction humaine ne réécrit ni le tri initial ni ses motifs. Elle n'entraîne pas d'apprentissage du modèle, de réaffectation ni d'action métier financière implicite.

## 7. Fonctionnalités terminées localement

Tickets issus de résultats terminés, correction tracée, statut, affectation autorisée, règles explicites pour les nouveaux tickets admissibles, reçus récupérables, projection d'équipe, listes récentes/paginées, mise à jour discrète, reprise des conflits de brouillon, langues FR/EN/DE/IT, thèmes et purge sur perte d'accès.

## 8. Fonctionnalités encore expérimentales ou absentes

L'activation hébergée, le worker de réception autonome, les délégations révocables, le contenu intégral et sa rétention, l'affectation dans un outil externe, les workflows client/rendez-vous persistants et le pilote multi-appareils réel restent à réaliser ou valider. Aucun nouveau fichier IPA/APK/DMG/installateur ni publication US n'est livré dans ce jalon. L'ERP US complet et l'objectif international restent ouverts.
