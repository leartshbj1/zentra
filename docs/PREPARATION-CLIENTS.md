# Préparation de Zentra pour les clients

Le suivi courant est [Audit premier client — corrections et preuves](AUDIT-PREMIER-CLIENT-SUIVI.md). Il remplace la liste qui décrivait encore la version 1.46.1 et un domaine à acheter.

## Informations confirmées

- Produit et domaine : Zentra, https://zentraapp.ch.
- Vendeur déclaré : Shabija Leart, non assujetti à la TVA suisse.
- Adresse fournie : Avenue de Châtelaine 72. Vérifier les coordonnées postales complètes publiées avant la recette commerciale.
- Contact fourni : info@zentraapp.ch.

Le statut TVA du vendeur est indépendant de celui des entreprises clientes. Ces informations ne prouvent aucune validation fiduciaire, certification Swissdec ou approbation en boutique.

## Conditions de livraison

1. Inscription extérieure, confirmation reçue et récupération de compte réussie.
2. Abonnements testés en mode test Stripe, droits et limites appliqués à tous les produits.
3. Deux installations réellement connectées au même espace, opérations simultanées et reprise hors ligne sans pertes ni doublons.
4. Travail d’Automation observé avec toutes les applications fermées, historique et récupération vérifiés.
5. Documents, montants, fournisseurs et paie vérifiés avec des attendus indépendants.
6. Sauvegarde .zentra compatible restaurée dans une installation isolée, pièces jointes comprises.
7. Artefact exact vérifié : version, empreinte, signature, installation neuve et mise à jour conservant les données.
8. Quatre langues, deux thèmes, écrans mobiles/ordinateur, erreurs, clavier et contenus longs vérifiés.

## Invariants

- Calculs en centimes et points de base, documents émis immuables et pièces traçables.
- Aucun remplacement silencieux d’une base modifiée ou d’un brouillon par la copie reçue.
- Sauvegardes intégrales réservées aux personnes autorisées ; les salaires et pièces jointes sont sensibles.
- Secrets, licences et clés propres à l’installation exclus des sauvegardes partagées.
- Un envoi accepté par SMTP ne prouve pas la livraison. Un build ne prouve pas une installation physique. Une IPA non signée n’est pas une publication App Store.
- Un échec réseau conserve les données et n’est jamais annoncé comme un succès.

## Preuves de release

Les manifestes, empreintes et preuves d’installation de la version exacte font foi. Le dossier disponible au début de cet audit est outputs/release1902/STATE.md : il distingue la publication des artefacts, leurs limites de signature et les essais physiques restant à réaliser. Les nouveaux travaux ne sont pas présentés comme déjà installés.