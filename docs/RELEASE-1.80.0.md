# Zentra 1.80.0 — réception, agenda et rapports

## Comportement

- Support reconnaît la catégorie rendez-vous. Avec une connexion Gestion active et Automation en mode suggestions, les confirmations complètes sont préparées côté serveur puis ajoutées à l'agenda par un appareil Gestion connecté. L'agenda utilise la synchronisation métier existante. Un appareil doit ouvrir Gestion pour effectuer cet import.
- Les calendriers ICS conservent leur UID. Les dates sont validées, les horaires explicites convertis vers Europe/Zurich, les fins de journée entière sont exclusives selon iCalendar. Séries, annulations, modifications d'un rendez-vous déjà importé et données ambiguës demandent une vérification.
- Réception fournisseurs : traitement de plusieurs factures, correspondance avec une fiche existante ou préparation d'une nouvelle fiche à identifiant stable. Les montants, la TVA et les contrôles de comptabilisation existants restent obligatoires. Les documents incomplets n'empêchent pas le traitement des autres.
- Les classements confirmés (fournisseur, catégorie, compte de charges) sont partagés dans l'entreprise et effaçables par un administrateur. Il s'agit de préférences enregistrées, pas d'un réentraînement du modèle. Aucun montant ni taux fiscal n'est appris.
- Tableau de bord : CA facturé hors TVA sur l'année, avoirs et déductions d'acomptes inclus, devises séparées. Cet indicateur de gestion n'est pas un décompte fiscal.
- Rapports : sélection d'un projet et de rubriques, aperçu puis export PDF natif paginé avec l'identité et le style de l'entreprise. Le rapport contient les données enregistrées et l'inventaire des documents ; il n'incorpore pas les pièces jointes originales.

## Vérification avant distribution

- Tests TypeScript ciblés : extraction/confirmation des rendez-vous, heures d'été, isolation des entreprises, reprise d'accusé de réception, classement des fournisseurs, données du projet, chiffre d'affaires et historique des versions.
- Tests Rust initiaux : import d'agenda idempotent, erreurs sans écriture partielle, création de fournisseur déterministe, import comptable et PDF long de huit pages. Première et dernière page du PDF inspectées.
- Interface de recette : rapport et réception sur ordinateur et à 390 px, confirmation d'un rendez-vous fictif visible dans l'agenda. Données de recette uniquement.
- La compilation web et TypeScript passent. Après changement du numéro de version, la protection applicative Windows bloque le nouvel outil de compilation local ; les scripts de compilation distante exécutent les nouveaux tests d'agenda et PDF avant de fabriquer les paquets.
- L'ajout serveur nécessite la migration 0057 et les routes appointments/supplier-inbox de la même livraison.

Les preuves de compilation, installation, signature et publication sont ajoutées aux sorties de livraison après leur vérification. Ce document n'atteste pas à lui seul la publication.
