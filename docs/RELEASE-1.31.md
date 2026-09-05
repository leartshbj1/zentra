# Zentra 1.31.0

Cette version améliore le suivi des dépenses et des remboursements, les coûts par projet et les contrôles de TVA.

- Un remboursement partiel ou total d’une dépense payée en CHF conserve séparément la date de l’avoir et celle de l’encaissement. Les écritures, la TVA et les corrections restent traçables.
- Un crédit bancaire importé peut être rapproché d’un remboursement déjà enregistré. Le rapprochement et son annulation ne créent aucune écriture supplémentaire. Un écart de date exige une justification.
- Les coûts des projets incluent la TVA non récupérable et déduisent les avoirs et remboursements validés sans les compter deux fois. Une imputation incertaine signale que la marge reste à vérifier.
- La sélection d’une dépense ou d’un remboursement s’efface lorsque la recherche la masque. Les formulaires, justificatifs et historiques restent utilisables sur mobile.
- Les périodes closes, les doublons, les plafonds de remboursement et les corrections antidatées sont contrôlés. Les archives conservent l’historique des rapprochements.

Validation avant emballage : 525 tests natifs réussis (1 ignoré), 676 tests d’interface, Clippy sans avertissement, compilation web et parcours navigateur à 320, 390, 768, 1024 et 1440 px. Les exports TVA des remboursements ont été validés contre les schémas eCH-0217.

Publication vérifiée le 5 septembre 2026 : installateurs Windows et macOS universel, signatures Ed25519, douze fichiers publics et canal de mise à jour 1.31.0. Le démarrage isolé des deux applications initialise une base SQLite intègre au schéma 48 ; Windows a également interrogé le canal public depuis l’application. Sur macOS, 526 tests natifs ont réussi (1 ignoré), ainsi que Clippy et les 676 tests d’interface. Les signatures de mise à jour ne constituent pas une signature Authenticode ou une notarisation Apple.

La page de téléchargement publiée a été contrôlée anonymement à 320, 390, 768 et 1440 px : liens des deux plateformes, absence de débordement, menu mobile et retour du focus au clavier. L’APK Android de test a été réduit de 91 438 738 à 56 390 159 octets ; le paquet compagnon x86_64 a passé le contrôle de démarrage et de récupération de l’identité sécurisée. Le paquet iOS ARM64 a passé les mêmes contrôles dans le simulateur.

Les remboursements bancaires groupés, en devise étrangère ou sans remboursement préalable, les changements historiques de méthode TVA et la synchronisation des données entre appareils restent hors de ce lot. Les versions mobiles restent des aperçus techniques ; cette version n’annonce aucune publication sur l’App Store ou Google Play.
