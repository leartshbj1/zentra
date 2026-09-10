# Pièces de recette TVA et comptes annuels

Données entièrement fictives. Aucun paiement à effectuer, aucune déclaration à transmettre.

La facture client, l’avoir client et les comptes annuels PDF sont produits par le moteur natif de Zentra. Le PDF fournisseur est un document d’entrée fictif créé séparément, puis importé et contrôlé par l’application. Les JSON, XML et le ZIP proviennent des commandes natives ou de leur vérification indépendante, selon leur nom.

`comparaison.json` rapproche les neuf montants attendus et constatés. `verification-fichiers.json` contrôle les sorties et l’intégrité des 21 fichiers du ZIP natif. `validation-xsd.json` décrit la validation du XML contre les schémas eCH. `provenance.json` identifie la source du moteur, le schéma 65 et le scénario exécuté. Les chemins temporaires dans les reçus natifs sont ceux du profil isolé utilisé pendant l’essai ; les copies livrées sont dans ce dossier.

Le dossier natif de clôture est provisoire (DRAFT). Son index référence les pièces ; l’original fournisseur est livré à côté. Le test ne certifie ni la conformité d’une entreprise réelle, ni Swissdec, ni l’acceptation d’une déclaration par l’AFC. La revue professionnelle reste à obtenir.

Compte rendu complet : docs/recette-fiduciaire/execution-2026-09-10.md dans les sources du projet.
