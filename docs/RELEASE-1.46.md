# Zentra 1.46.0 - préparation de distribution

Les installateurs 1.46.0 sont en préparation. Les liens et le manifeste publics restent sur la version 1.45.0 jusqu'à vérification des nouveaux artefacts.

## Changements à livrer

- Sauvegarde complète de l'entreprise dans le coffre distant, sur demande ou chaque jour lorsque l'application est ouverte et l'option activée.
- Reprise d'un envoi interrompu, restauration dans une installation neuve et contrôle des empreintes, de la base, des écritures comptables et du journal d'audit.
- Récupération web des sauvegardes pour le titulaire et les administrateurs, y compris après résiliation ; restauration locale sans réactiver un abonnement.
- Correction du transfert des fichiers de projet et de l'accès aux fiches de salaire importées après restauration sur un autre appareil.
- Nettoyage d'une session cloud dont l'échange de licence était resté inachevé.

Le schéma local passe à 59. La préparation de la numérotation partagée est incluse, mais son initialisation et la réplication métier complète restent inactives ; aucune activation automatique n'est annoncée.

## Contrôles disponibles avant les builds

- 742 tests d'interface réussis et analyse Clippy complète sans avertissement pour Windows.
- Douze tests natifs de numérotation, dont demandes concurrentes, restauration, rejeu et planification des années.
- Recette HTTPS réelle de sauvegarde et restauration de 9,5 Mo, avec deux profils Windows indépendants et nettoyage des données fictives. Cette recette a été exécutée avant la seule intégration du planificateur de numéros, sans liaison partagée active.

## À vérifier avant annonce de publication

- Source exacte de chaque lot, versions et identifiants de paquet, signatures de mise à jour, SHA-256 et disponibilité publique des fichiers immuables.
- Installation Windows neuve et mise à jour depuis 1.45.0 avec conservation des données.
- Compilation universelle macOS et démarrage du paquet ; noter séparément la signature ad hoc, la signature de mise à jour et une éventuelle notarisation Apple.
- Android : APK, certificat de signature et essai de mise à jour depuis le paquet précédent. iOS : distinguer simulateur, IPA non signé et distribution Apple officielle.
- Téléchargements et manifeste commun Windows/macOS publiés seulement après ces contrôles. Les comptes Apple/Google de distribution et les essais sur appareils physiques restent des critères distincts.
