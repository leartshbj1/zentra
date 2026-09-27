# Écran de mise à jour — quatre langues et lisibilité

Lot du 27 septembre 2026, **postérieur à la version publique 1.90.6, non publié**. Extension de l’interface existante Operate / « Précision calme », sans changement de protocole de mise à jour ni de politique de sécurité.

## Comportement

- Titres, étapes, boutons, confirmations, erreurs connues et informations techniques en français, allemand, italien et anglais. Dates et tailles suivent la langue sélectionnée ; versions et diagnostics techniques inconnus restent exacts. Les notes reçues du serveur restent dans leur langue d’origine.
- Les boutons et étapes se réorganisent sur téléphone. À 320 px et 200 % de taille du texte, les commandes du bandeau occupent leur propre ligne pour garder le titre allemand entier.
- Le refus Windows 4551 explique la protection qui bloque l’installation et conserve l’erreur originale dans les détails. Le message ne prétend pas résoudre la signature ; aucune protection Windows n’est abaissée.
- Sur mobile, l’écran indique de reprendre la boutique ou l’outil ayant servi à installer Zentra. Il ne prétend plus que les éditions actuelles sont publiées dans les stores. La commande native mobile n’est pas un installateur.

## Validation et limites

**1 822 tests / 224 fichiers** réussis avant la dernière retouche du bandeau à texte agrandi ; **13 tests ciblés**, TypeScript, puis build Vite final réussis. L’avertissement préexistant de chunks supérieurs à 500 Ko est conservé. Contrôles des variables de traduction, formats de taille/date et valeur exacte des versions.

**26 configurations de parcours navigateur** Edge/Chromium et WebKit réussies : quatre langues, 320/1440 px, deux cas allemands à 200 %, huit vues mobiles à 390 px. Les parcours couvrent recherche, confirmation, installation simulée unique, protection contre la fermeture pendant l’installation, refus 4551, accès au diagnostic puis nouvelle recherche effaçant le diagnostic. **Deux confirmations finales** allemandes 320 px/200 % passent après la retouche du bandeau. Aucun débordement du viewport ou des libellés contrôlés, aucune erreur JS dans ces parcours.

Une reprise du contrôle final WebKit a été nécessaire : le sélecteur de fermeture du guide préliminaire avait capturé un libellé transitoire en français. Le scénario utilise maintenant le bouton structurel de ce guide ; les attentes traduites de l’écran testé restent exactes. Aucun résultat en échec n’est compté comme réussi. La première invocation de build via `npm.cmd`, absent de ce runtime, n’a pas lancé de compilation ; l’appel direct à Vite a ensuite réussi.

Captures finales bureau anglais, mobile italien et allemand à 200 % dans les deux moteurs relues. Deux passes visuelles bornées ; aucun statut d’audit global d’accessibilité ou de revue indépendante n’est revendiqué.

Preuves : `desktop/.qa/updater-language-{all-tests,unit,final-build}.log`, `desktop/.qa/updater-languages/report.json`, `desktop/.qa/updater-languages-large-final/report.json` et captures de ces deux dossiers. Scénario reproductible : `desktop/tests/updater-language-journey.mjs` (`ZENTRA_QA_LARGE_ONLY=true` pour le contrôle final ciblé).

**IPC et entreprise fictifs, réseau externe bloqué** : ces parcours ne prouvent ni installation réelle, ni reconnexion de compte, ni synchronisation serveur. Le changement de texte Rust mobile n’a pas encore été compilé dans un paquet ; Android 157 précède ce lot. Le PC reste en 1.90.5 après le refus documenté de l’installateur public. Les données réelles n’ont pas été modifiées.
