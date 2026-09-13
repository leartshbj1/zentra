# Langues de l’interface — travail en cours

Le choix Français / Deutsch / Italiano / English apparaît au début de la configuration et dans Paramètres → Langue et région. Le choix est conservé sur l’appareil et fonctionne sans réseau. Il ne modifie ni l’identité de l’entreprise, ni ses coordonnées, ni les textes des documents. Le français reste le choix initial pour les installations existantes.

## Périmètre intégré

- Configuration initiale : étapes, champs, principales validations avec retour au bon champ, confirmation, installation facultative de Qwen.
- Les 22 sections et 87 divisions du catalogue NOGA 2025 existant, avec le libellé sélectionné affiché intégralement sous les listes. Les codes enregistrés restent identiques. Les traductions servent à l’affichage ; elles ne remplacent pas le catalogue natif.
- Sélection de langue dans les paramètres, titres des catégories, navigation HTML sur ordinateur et mobile, recherche de rubriques dans la langue choisie, connexion au compte.
- Recherche des assurances : libellés, explications, nombre de résultats et indications des répertoires. Les noms des organismes sont conservés.
- Aide « Comprendre cet écran » : les actions et conseils des 17 rubriques, les 14 définitions financières et les titres des sources. Les liens officiels existants sont conservés.
- Paie : messages de validation des champs, guides de correction, préparation des informations manquantes, calcul horaire, confirmation des bases d’assurance et saisie des deux parts de pension. Les titres, actions et documents à consulter des guides sont traduits après le classement des messages natifs : les destinations, sélecteurs et regroupements restent identiques. Le détail d’origine du système est conservé.
- Changer de langue pendant ces étapes conserve les champs saisis, les explications dépliées, les valeurs financières et les références contractuelles. Les libellés enregistrés sur les documents ne sont pas retraduits. La mention « obligatoire » reste sur une seule ligne, y compris sur petit écran.
- Les fonctions communes de présentation des montants et dates utilisent fr-CH, de-CH, it-CH ou en-CH. Les calculs, données sauvegardées et validations financières restent inchangés.

La traduction reste explicitement signalée comme **en préparation** dans le sélecteur pour les langues autres que le français. Les formulaires métier non migrés, le tutoriel guidé complet, l’assistant conversationnel, les contrôles Apple natifs et les PDF ne sont pas encore entièrement traduits. Les textes natifs inconnus restent lisibles dans leur langue d’origine. Il ne faut pas présenter cette étape comme une traduction intégrale de Zentra.

## Vérification

Les tests de configuration vérifient le choix de langue, le rechargement, la conservation des saisies et des codes NOGA, les validations visibles et l’absence de débordement horizontal. Les sept étapes sont visitées avec un brouillon de test : ce contrôle de disposition ne constitue pas une création native complète d’entreprise.

Les tests des paramètres vérifient les quatre langues, la conservation d’un champ de société déjà saisi, la connexion, la recherche des menus et les définitions financières. Les fenêtres testées sont 320 × 568, 390 × 844, 844 × 390 et 1440 × 1000. Chromium/Edge et WebKit ont été utilisés. Les rendus sont également inspectés visuellement.

Les tests unitaires contrôlent les paramètres des traductions, la conservation des valeurs utilisateur, les échecs d’enregistrement de préférence, la couverture des aides et celle des 109 codes NOGA. `languageCatalogCoverage.test.ts` couvre les clés explicitement migrées ; il ne prouve pas que toutes les chaînes de l’application sont traduites.

Recettes : `desktop/tests/language-onboarding-journey.mjs` et `desktop/tests/language-settings-journey.mjs`. Rapports et captures dans les dossiers `.qa/language-*` des checkouts de développement. Aucun compte client réel ni document financier n’est modifié par ces recettes.

La recette `desktop/tests/payroll-language-journey.mjs` monte les composants de paie dans une fenêtre réelle de l’application avec des données synthétiques. Elle vérifie les quatre langues aux quatre tailles ci-dessus : correction d’une date dans un volet fermé, e-mail facultatif, conservation de la saisie et des descriptions accessibles, navigation vers le champ source, calcul horaire exact, confirmation d’une base et reprise après échec de la seconde part de pension sans doublon. Elle ne constitue pas une paie comptabilisée par le moteur natif. Le port WebKit de test sous Windows ne fournit pas de champ date natif : le repli en champ texte est contrôlé explicitement (date réelle, format ISO et bornes inclusives). Cela ne remplace pas un essai sur iPhone physique.

`payrollLanguage.test.ts` contrôle la traduction des branches de validation et des guides, les bornes calendaires, et l’invariance du routage. Les messages système inconnus et les autres formulaires de paie restent à migrer ; le parcours de paie entier ne doit pas encore être annoncé comme intégralement traduit.

Cette étape ne génère aucun nouvel installateur Windows, macOS, APK ou IPA et n’a pas été publiée sur le site.
