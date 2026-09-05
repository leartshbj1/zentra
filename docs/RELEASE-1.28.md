# Zentra 1.28.0

Cette mise à jour améliore la consultation des documents, le traitement des achats et la reprise des opérations bancaires sur ordinateur et téléphone.

- Devis et factures : recherche de référence bancaire, filtres par état et affichage par lots de 25. Les soldes tiennent compte des paiements et des avoirs. Les documents restent classés du plus récent au plus ancien.
- Devises et projets : la devise est conservée dans les formulaires et les montants sont regroupés par devise. L'éditeur propose les projets du client sélectionné. Une marge nécessitant une conversion manquante reste signalée.
- TVA des achats : les classifications non déductibles et leur correction mettent à jour le journal et les états comptables, sans réécrire les pièces originales. En méthode TDFN, la TVA des achats entre dans les charges.
- Avoirs fournisseurs : réduction de l'impôt préalable en mode « convenues », classement des lignes et correction des achats non déductibles. Les périodes clôturées restent protégées.
- TVA en mode « reçues » : ventilation des règlements partiels dans leur période, avec détail daté des montants HT, TVA et TTC. Les sources encore impayées doivent être classées avant la clôture, sans déduction anticipée.
- Banque : recherche, pagination, montants et propositions plus lisibles sur mobile. Si l'actualisation échoue après un paiement enregistré, le résultat reste confirmé ; le bouton d'actualisation recharge les données sans enregistrer un second paiement.
- Menus et formulaires : sections Achats et TVA adaptées aux petits écrans, erreurs visibles et saisies conservées lors des reprises.

## Avant de reprendre un historique comptable

La migration 42 conserve les classifications existantes. Elle n'identifie pas les corrections de TVA déjà saisies manuellement au journal : vérifier ces écritures avant d'appliquer une nouvelle correction sur un ancien achat. Les avoirs en mode « reçues », les changements de méthode portant sur des soldes ouverts et les pièces anciennes non classées dans une période déjà clôturée nécessitent encore un traitement spécifique. Les situations non prises en charge sont signalées dans les contrôles ; aucune acceptation du décompte par l'AFC n'est annoncée.

Les règles, preuves de calcul et limites figurent dans [l'audit fonctionnel](AUDIT-APP-2026-09.md). Le périmètre des références QR/RF, du relevé camt.053 et du bilan exportable reste décrit dans [Finances suisses 1.27](FINANCES-SUISSES-1.27.md) ; ses restrictions sur les paiements partiels et les avoirs fournisseurs en mode « convenues » sont levées par cette version.

## Distribution

Les paquets de mise à jour Windows et macOS utilisent la clé de mise à jour Zentra existante et l'identifiant d'application de production. Windows Authenticode et la notarisation Apple restent indisponibles. Les builds mobiles restent des versions de test, sans publication sur l'App Store ou Google Play. Cette version n'ajoute pas de synchronisation des données entre appareils.
