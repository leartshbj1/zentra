# Support US — entreprise, droits et raccord progressif

Base : `8236d41`. L'objectif ERP international reste entier et actif. Ce jalon H1 prépare une identité Support par entreprise ; il ne prétend pas recevoir ou classer les emails US.

## Constats vérifiés

- Les droits SaaS US savent vérifier Gestion et Support ; le paiement initial US admet Gestion/Complet. Seul Complet donne actuellement Support dans ce parcours.
- Le Support existant possède un espace unique par propriétaire (`support_workspaces_owner_id_unique`). Ses connexions, tickets, événements et boîtes ont des clés étrangères vers ce parent. Ses droits et liens Gestion utilisent les organisations legacy.
- Réutiliser un espace legacy pour plusieurs entreprises US mélangerait leurs données. Un simple adaptateur de métadonnées ne résout pas les clés étrangères. Aucun faux propriétaire, suppression d'index, reconstruction de table legacy ou emprunt d'abonnement CHF n'est retenu.
- Les originaux et propositions fournisseurs US existent, mais la réception mail, la délégation par boîte et le budget de classification US ne sont pas raccordés. Le quota `supplier_invoice_extract` ne peut servir de quota de tri général.

## H1 livré dans ce jalon

1. Registre D1 additif `international_us_support_workspaces`, un espace par entreprise US, sans écrire dans les tables Support legacy.
2. Création owner/admin avec Auth frais et Gestion + Support sur la même autorité effective US/USD, facture et période. Un renouvellement pendant une opération impose une nouvelle lecture. Lecture réservée aux membres actuels.
3. Reçus immuables par entreprise/acteur/requestId et hash matériel. Reprise exacte après réponse perdue ; commande différente sous le même identifiant refusée. Un espace existant ne peut être réaffecté ni renommé implicitement.
4. API privée, contrôles avant/après les awaits, origine vérifiée pour les mutations navigateur, identité attendue, session appareil bornée, erreurs publiques fermées et journaux sans données métier.
5. Panneau de préparation FR/EN/DE/IT, clair/sombre, dans l'espace US. Il indique explicitement que boîtes et traitement sont encore indisponibles. Aucun lien ne contourne ces contrôles vers Support legacy.
6. Gate `INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED` fermée par défaut, en plus de Core/ERP. Migration absente : indisponibilité explicite. Fermer la gate conserve le registre.

## Suite obligatoire H2/H3

- Réutiliser les moteurs communs de connexion, classification et routage derrière un contrat de persistence national. Le stockage US dédié nécessaire aux contraintes legacy ne constitue pas une seconde application indépendante. Toute migration ultérieure du parent commun exige son plan explicite et ses tests CH.
- Délégations par boîte/acteur/actions, consentement worker, révocation et CAS. Les droits Support ne donnent pas les droits financiers.
- Politique et budget de classification US séparés ; aucune génération de texte libre attribuée à Jev.
- Reçus privés de provenance par pièce jointe, identité message/UIDVALIDITY, liaison et révision, archive avant analyse, acquittement indépendant des erreurs Automation.
- Analyse US existante lorsque droits/consentement/budget sont valides, puis proposition et approbation financière humaine. Conserver `document_import` avec provenance privée ou étendre explicitement son contrat SQL avant `support_mail`.
- Intégration des têtes de synchronisation, charge, staging autorisé, tests hébergés et distribution native restent ouverts.

## Validation et rollback

Tests contrat/HTTP/transport/UI, vraie chaîne SQLite locale incluant0092/0093, isolation CH/US, deux entreprises d'un owner, rôles, Gestion seul, révocations, période courante, sessions, concurrence et reprises. TypeScript, lint ciblé et build de production. Inspection navigateur en langues/thèmes mobile et bureau selon outils disponibles.

Aucune migration hébergée, activation de gate, opération Stripe live, suppression de données ou publication de routes US n'est autorisée par ce jalon local. Rollback applicatif : fermer la gate puis revenir au commit précédent ; conserver tables et reçus. Pas de rollback SQL destructif automatique.
