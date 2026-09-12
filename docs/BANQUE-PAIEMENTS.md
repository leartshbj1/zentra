# Importer un relevé et retrouver les paiements

Dans **Banque → Importer un relevé XML**, le guide explique où trouver le fichier dans l’e-banking. **Choisir le relevé XML** permet de sélectionner le fichier sans lancer l’import. Vérifiez son nom, choisissez si Zentra doit enregistrer les paiements clients reconnus, puis utilisez **Importer ce relevé**.

L’option automatique reste telle que vous l’avez choisie pendant la session, même après un passage par la comptabilité. Un nouveau démarrage reprend la valeur par défaut. Un fichier refusé reste sélectionné et l’explication indique comment obtenir un relevé compatible. Vous pouvez choisir un autre fichier ou reprendre le même ; les contrôles natifs de doublons restent actifs.

Le résultat distingue les nouveaux mouvements, ceux déjà connus, les factures entièrement payées, les versements partiels et les encaissements à vérifier. Les avertissements et entrées non exploitées restent consultables. Si la relecture échoue après l’import, **Actualiser les données** reprend la lecture sans réimporter le fichier.

Utilisez **Vérifier les comptes du relevé** pour confirmer les comptes appartenant à l’entreprise, puis **Voir les mouvements à vérifier**. L’association d’un compte se confirme dans l’application. Elle ne donne aucun accès à votre e-banking et ne déclenche aucun virement.

Pour un paiement manuel, choisissez la facture puis ouvrez la confirmation. La fenêtre présente la facture, le montant bancaire, le reste dû après et avant paiement, le payeur ou bénéficiaire et la date. Pendant l’enregistrement, elle empêche les doubles soumissions et reste ouverte. Après un refus, vos choix sont conservés et le message est visible dans la fenêtre. Pour une période clôturée, **Vérifier la comptabilité** ouvre directement **Exercices** ; pour une configuration incomplète, le raccourci bancaire ouvre **Plan & liaisons**.

Un paiement enregistré dont l’affichage ne s’est pas actualisé reste enregistré : reprenez la lecture proposée. Les mouvements encore en attente auprès de la banque restent consultables sans être proposés comme paiements définitifs. Les règlements fournisseurs se confirment séparément.

## Formats et portée

Le guide conseille le relevé XML **camt.053**, format de relevé de compte décrit par [SIX](https://www.six-group.com/fr/products-services/banking-services/payment-standardization/downloads-faq/glossary.html). Le moteur Zentra accepte actuellement camt.053 et camt.054 en versions 001.04 et 001.08 ; ses contrôles automatiques attendent le camt.053 définitif. Ces limites proviennent de l’implémentation contrôlée dans `bank_import.rs`, et ne constituent pas une affirmation de prise en charge de tous les messages ISO 20022.

Les fichiers de test et entreprises utilisés pour la recette sont fictifs. Aucune banque réelle ni donnée client n’a été modifiée. Le moteur, le schéma et les règles de comptabilisation ne sont pas modifiés par ce lot d’interface. Ce travail prépare une prochaine livraison ; il ne remplace pas le lot Windows 1.58.0 déjà publié.

## Vérification du 12 septembre 2026

- TypeScript et compilation Vite réussis dans la base de livraison et dans le projet principal.
- 30 tests d’interface bancaires réussis dans les deux dossiers ; 46 autres tests comptables, de preuves de paiement et de trop-perçus réussis dans le projet principal.
- 72 tests du moteur bancaire réussis : paiements et journaux atomiques, doublons et reprises, clôtures, références ambiguës, versements partiels, fournisseurs, dépenses et remboursements.
- Huit parcours guidés Edge/WebKit réussis dans chaque dossier, en 320 × 568, 390 × 844, 844 × 390 et 1 440 × 900. Ils couvrent aussi l’ouverture des bonnes rubriques comptables et la conservation du choix d’import après navigation. Cinq parcours bancaires existants réussis sur Edge aux largeurs 320, 390, 768, 1 024 et 1 440 pixels.
- Captures mobile et ordinateur inspectées : reste dû visible avant confirmation, explication du refus lisible et raccourci comptable accessible.

Les rapports se trouvent dans `desktop/.qa/bank-guided/report.json`, `desktop/.qa/bank/report.json` et `.qa/bank-workflow-native.log` de la base de livraison ; le dossier principal conserve son propre rapport guidé. Ces essais ne constituent pas une recette sur un profil client installé.
