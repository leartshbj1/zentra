# Audit Zentra et Zentra Support — 20 septembre 2026

## Résultat

Les contrôles automatisés et les parcours décrits ci-dessous sont validés après corrections et relance isolée des tests de synchronisation. La connexion Zendesk pour les clients n'est pas encore configurée en production. Cet audit ne constitue ni une certification comptable ou de sécurité, ni une validation sur tous les appareils physiques.

L'application distribuée reste en version **1.71.1**. Aucun nouveau binaire natif n'est produit par cet audit. Les corrections de production portent sur le site et Zentra Support.

## Corrections apportées

- Paiement Support : l'acceptation des conditions est enregistrée avant de retourner le lien Stripe. Une nouvelle tentative conserve la date, la version des conditions et l'identité originales, et répare une acceptation manquante après interruption. Deux tests reproduisent ces interruptions et leur reprise.
- Navigation Support sur petit écran : les six onglets sont répartis en deux rangées de trois, sans chevauchement constaté à 320 px.
- Les boutons de choix d'abonnement ouvrent directement la section Abonnement. Le retour après connexion conserve la section et l'espace sélectionnés.
- L'icône du site est fournie à `/favicon.ico`, qui renvoyait auparavant une erreur 404.
- Les fixtures des tests de consentement et de numérotation ont été mises à jour. Deux tests HTTP vérifient la réservation du numéro via Supabase et l'absence de compteur local de secours si le service échoue.

Une traduction de l'aide sur l'impôt à la source a aussi été complétée en allemand, italien et anglais dans le checkout de développement principal. Ses quatre tests ciblés passent. Ce changement local ne fait pas partie de la version native distribuée.

## Tests exécutés

| Ensemble | Résultat |
| --- | --- |
| Interface de l'application 1.71.1 | 1 543 tests réussis, 186 fichiers |
| Moteur natif Rust 1.71.1 | 720 tests réussis, 3 ignorés |
| Site et Support | 986 tests exécutés validés, 63 ignorés, 77 fichiers |
| TypeScript | Application et site validés |
| Compilation du site | Réussie |
| Lint ciblé | Fichiers de facturation et tests modifiés validés ; pas de déclaration de propreté globale du dépôt |

Total : **3 249 tests de production validés**. Précision : l'exécution globale du site a produit 982 réussites et quatre échecs dans trois fichiers lors des tests natifs concurrents. Les délais dépassés et l'échec consécutif ont disparu en relançant ces trois fichiers seuls : 49 réussites, 7 ignorés. Le total de 986 compte les tests uniques, pas les relances.

Les trois tests natifs ignorés nécessitent respectivement deux appareils autorisés pour une sauvegarde distante réelle, une copie d'entreprise fournie pour diagnostic, et un rafraîchissement HTTPS réel de licence. Les 63 tests web ignorés ne sont pas déclarés validés.

Les tests couvrent notamment devis, factures, acomptes, avoirs, comptabilité, TVA, stock, banque, paie, sauvegardes, fusion et synchronisation, licences et mise à jour. La couverture automatisée ne prouve pas l'absence de tous les défauts dans ces domaines.

## Parcours à l'écran

- Application à 390 px : accueil, agenda, projets, clients, produits et services, ventes, équipe et salaires, achats et fournisseurs, banque, rapports et paramètres. Aucun débordement horizontal visible constaté dans les contrôles réalisés.
- Comptabilité en mode sombre, puis passage au mode clair dans les paramètres : contrôle visuel sans surface sombre résiduelle constatée.
- Paie sur données fictives : sélection d'une collaboratrice, salaire prérempli, aperçu du net et enregistrement d'un brouillon. Confirmation visible et nouvelle fiche dans la liste. Aucune fiche réelle modifiée.
- Support à 320 px : sections de la démonstration, navigation corrigée et application simulée d'un routage manuel. Aucun ticket client modifié.
- Pas d'erreur de console constatée dans ces parcours. Les essais utilisent un navigateur et des données de démonstration ; ils ne remplacent pas un essai sur iPhone, Android ou Mac physique.

## Services et accès

- Les douze pages publiques contrôlées répondent HTTP 200 : accueil, Support, espace, administration, démonstration, conditions Support, connexion, compte, téléchargements et trois pages légales.
- Sans session, les API de l'espace Support et de son administration répondent HTTP 401.
- L'administration privée confirme le fournisseur d'analyse configuré et les trois offres Stripe actives en mode réel : 29 CHF / 2 000 analyses, 49 CHF / 5 000 analyses, 99 CHF / 15 000 analyses par mois.
- Aucun paiement réel effectué pendant cet audit. Le cycle achat réel → événement Stripe → droits du client n'a pas été rejoué de bout en bout avec un client payant.
- Tests Workerd/D1 locaux réussis : création d'espace, configuration des connecteurs, refus d'analyse sans abonnement, accès et mutations soumis aux droits, séparation de l'administration.
- Contrat Supabase statique validé : contrôles RLS, stockage privé des PDF, rétention et protections d'immutabilité attendues. Ce contrôle n'est pas une inspection exhaustive des politiques effectivement déployées.
- Stockage testé dans Workerd local : envoi, récupération des octets exacts, suppression et refus de redirections indésirables.

## Analyse automatique réelle

Un appel réel au fournisseur a exécuté les douze scénarios synthétiques de calibration avec le seuil de 85 % : **10 scénarios strictement conformes, 8 propositions automatiques, 4 validations humaines**.

Les deux écarts restent en validation humaine : une question produit correctement catégorisée mais avec seulement 67 % de confiance, et un message contenant « urgent » classé en priorité basse au lieu de normale avec 41 % de confiance. La demande explicite d'un responsable et une instruction malveillante sont restées en validation humaine.

Ce petit jeu ne mesure ni la précision générale sur les tickets des clients, ni un gain de temps de 20–30 %. Aucune affectation réelle dans un outil client n'a été effectuée lors de cette calibration.

## Zendesk et limites avant lancement complet

La configuration de production renvoie `configured: false` et `ready: false` pour Zendesk. L'existence d'un client OAuth global approuvé dans le compte du propriétaire reste inconnue. L'accès à sa session Zendesk n'a pas pu être inspecté lors de cet audit.

Pour le bouton d'autorisation destiné aux entreprises clientes, il faut obtenir ou retrouver le client OAuth global puis renseigner ses identifiants côté serveur. La procédure officielle précise qu'un client global se demande à Zendesk : [documentation Zendesk](https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/).

Il reste ensuite à valider réception d'un ticket, classement et affectation dans un vrai compte de support connecté. Les parcours réels Zendesk, Freshdesk et Gorgias n'ont pas été exécutés avec des comptes clients pendant cet audit. L'autorisation publique Gorgias n'est pas implémentée et l'interface l'annonce comme à venir.

La limitation de réception de 1 000 nouveaux tickets par jour et par espace mérite d'être explicitée commercialement à côté des quotas mensuels. Aucun tarif, seuil d'analyse ou droit client n'a été changé pendant cet audit.

## Distribution native

Les quatre fichiers disponibles ont été téléchargés en flux intégral et comparés aux empreintes attendues :

| Plateforme | Taille en octets | SHA-256 |
| --- | ---: | --- |
| Windows | 23 558 602 | `8f6d441bde40966e20d42e62c42ad3b55f7a3f28163db1a0ed95d559d41912be` |
| macOS | 50 468 505 | `e784181371f92bf129a7a0c245d753c9b22135d49edf9c39ebe4db0e803cc873` |
| iPhone | 25 124 878 | `8466b39a893ffae186624cf5e1ded940b24f988ebcc93c63e2021865db9da7e0` |
| Android | 76 136 975 | `96b6073cd851a32b48889670aee2afe39b38dea3e7b66f52b847ed2e6fdd8023` |

Les manifestes Windows et macOS répondent HTTP 200 et annoncent 1.71.1. Les empreintes concordent pour les quatre fichiers. Cela vérifie leur disponibilité et leur intégrité, pas leur installation physique.

Limites de distribution documentées : Windows sans Authenticode, macOS avec signature ad hoc sans notarisation Apple, IPA non signé pour installation manuelle, Android ARM64 de test avec débogage activé. Aucune publication App Store ou Play Store n'est revendiquée.

## Traçabilité

- Source native auditée : `8dbc30d1` sur `codex/company-merge-20260915`, identique pour `desktop/` au commit distribué `0b1393fc5eaa2fae88acb92301576d39e2c434d1`.
- Source web avant corrections : `356532be6dd8a25a0e3cd1deb08453b432ae7ad7` sur `codex/support-jev-20260919`.
- Journaux locaux : `outputs/audit-20260920-ui.log`, `outputs/audit-20260920-native.log`, `outputs/audit-20260920-tests-final.log`, `outputs/audit-20260920-sync-isolated.log`, `outputs/audit-20260920-build-final.log` dans les checkouts correspondants.
- Contrôles de production : `outputs/audit-live-20260920.json`, `outputs/audit-triage-20260920.json`, `outputs/audit-downloads-20260920.json`.

La référence de publication et les vérifications publiques après déploiement sont conservées séparément dans `outputs/audit-publication-20260920.json` une fois le déploiement terminé.
