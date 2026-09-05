# Zentra 1.33.0

Cette version permet de créer le remboursement d’un achat directement depuis le crédit reçu dans un relevé bancaire.

- Sélectionnez la dépense d’origine, renseignez l’avoir et sa TVA, puis joignez un PDF ou une photo. Le montant reçu et sa date viennent du relevé.
- La création du remboursement, son encaissement, son rapprochement et son justificatif sont enregistrés ensemble. Un refus ou une interruption ne laisse pas une partie de ces opérations enregistrée ; un nouvel essai identique évite les doublons.
- Retrouvez ensuite la dépense et ses pièces depuis la banque et le dossier du projet. Les achats sans paiement daté ou dont le montant disponible est insuffisant sont signalés avant validation.
- Le parcours s’adapte aux petits écrans avec deux étapes, une recherche et des boutons tactiles. Les commandes de paiement client inutiles sont masquées quand aucun client n’est proposé.
- La sélection d’un justificatif invalide retire maintenant le fichier précédemment choisi : aucune ancienne pièce ne sera jointe par erreur à une nouvelle dépense bancaire.

Validation du code : **535 tests natifs réussis (1 ignoré), 684 tests d’interface, Clippy et compilation web**. Les parcours bancaires, remboursements et dépenses sont vérifiés à 320, 390, 768, 1024 et 1440 px, ainsi qu’en lecture seule. Les essais contrôlent les interruptions, les nouveaux essais, les pièces jointes et les refus de périodes clôturées sur des données isolées. Le schéma SQLite reste à 49.

La publication des paquets de cette version est en préparation. Les signatures et démarrages des paquets finaux, le canal de mise à jour et les téléchargements publics doivent encore être vérifiés pour cette version.

La préversion Android conserve la signature persistante introduite en 1.32.0. Voir [la procédure et les limites des anciennes signatures](ANDROID-PREVIEW-SIGNING.md). Le ZIP iOS est destiné au simulateur ; il ne s’installe pas directement sur iPhone. Les aperçus ne constituent pas une publication App Store ou Google Play. Authenticode Windows, notarisation Apple, essais sur appareils physiques, mises à jour automatiques mobiles et synchronisation entre appareils restent à réaliser.
