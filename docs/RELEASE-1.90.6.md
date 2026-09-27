# Zentra 1.90.6

- Personnalisation des documents et outils de texte en français, allemand, italien et anglais. Recherche directe du réglage, valeurs et textes du client conservés.
- Bouton de retour de l’atelier accessible pendant le défilement ; choix du format adaptés au texte agrandi sur mobile. Nom des polices Inter et Literata corrigé dans les modèles.
- Rendez-vous reçus visibles dans le journal Automation, avec ouverture du jour exact. Dates invalides et éléments absents de l’appareil signalés.
- Détails Automation et indications de correction plus lisibles et traduits.

Cette version ne rétablit pas à elle seule le service de comptes restreint par ses quotas ni le traitement automatique lorsque les applications sont fermées. Ces incidents sont suivis séparément.

Source gelée : **`9ec8e782a160e7fe2cdf3b853e19e54bbfa64a01`**, branche `codex/first-client-release-1906`. Les exécutions CircleCI **150 Windows, 151 Android et 152 Apple** sont confirmées en cours le 27 septembre à 21 h 24 (Europe/Zurich). Aucun paquet 1.90.6 n’est encore vérifié ni publié. La préparation du contrôle Windows séparé n’en modifie pas la source applicative.

La dernière suite frontend compte 1 814 tests réussis ; les recettes des lots figurent dans `AUTOMATION-DETAILS-20260927.md`, `AUTOMATION-RENDEZ-VOUS-20260927.md`, `DOCUMENT-NAVIGATION-LANGUES-20260927.md` et `DOCUMENT-EDITOR-LANGUES-20260927.md`. Les 14 contrats de livraison, TypeScript, build Vite et 50 actifs de marque passent avant gel. Les chaînes Windows et Apple vérifient aussi le moteur de composition PDF et les tests frontend de l’éditeur. Les preuves navigateur utilisent des données fictives et ne valent pas validation d’un appareil physique ou du service en production.

Distribution prévue selon les configurations existantes : Windows sans Authenticode ; Mac universel signé ad hoc, sans notarisation ; IPA non signé ; APK Android arm64 de test, débogable. Les paquets de mise à jour seront signés seulement après vérification. Aucun dépôt en boutique n’est annoncé.
