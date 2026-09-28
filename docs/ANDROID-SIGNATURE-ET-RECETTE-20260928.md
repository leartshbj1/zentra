# Android optimisé — signature et recette

28 septembre 2026, 02 h 05. Travail sur des candidats de validation, **sans remplacement de la release publique 1.90.6**.

## Signature locale vérifiée

Le paquet arm64 optimisé du job CircleCI 157 (`a490d797e2358dc95fc1615e48ea82eb400f86b1`) a été signé avec l’identité persistante des préversions Zentra, sans changement de clé. Cette identité reste distincte d’une publication Google Play.

| Contrôle | Résultat |
|---|---|
| Fichier | `Zentra-1.90.6-Android-arm64-optimized-preview.apk` |
| Taille signée | 39 830 238 octets, environ 68 % de moins que l’APK public de 122 885 130 octets |
| SHA-256 signé | `36c191d52943a5826fe5ab19eee0811d3abae4982f3388e9bf5a8b65b062b1bb` |
| Certificat SHA-256 | `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670` |
| Signature Android | v2 et v3 valides ; un seul signataire, certificat conforme à celui du dépôt |
| Contenu | 964 entrées applicatives strictement identiques avant/après signature |
| Manifeste | Version 1.90.6/code 1090006, minimum Android 24, cible 36 ; non débogable, sauvegarde Android désactivée |
| Alignement | Archive et bibliothèques natives compatibles avec les pages de 16 Ko |
| Contre-épreuve | Modification d’un octet de la copie signée : rejet par `apksigner`, code 1 et erreur d’intégrité |

`sign-android-preview-candidate.ps1` vérifie la provenance, l’empreinte attendue, le manifeste et l’alignement avant d’ouvrir l’identité protégée par DPAPI. Le magasin temporaire est restreint au compte Windows courant, puis supprimé dans le bloc de nettoyage. Aucun secret ou clé n’est envoyé à CircleCI. Le script refuse d’écraser un paquet ou reçu existant.

`verify-android-preview.py` vérifie la signature, le certificat épinglé et tout le contenu applicatif ; le reçu n’est écrit qu’après réussite. Neuf tests unitaires des contrôleurs passent, couvrant notamment les mauvais signataires, la signature v2 absente, les fichiers modifiés/ajoutés/supprimés, les bibliothèques mal alignées et les captures d’accessibilité périmées. La contre-épreuve ci-dessus utilise réellement l’outil Android, pas un résultat simulé.

Preuves : `outputs/android-release-candidate-20260927/job157/signed/`, notamment `*.verification.json`, `signature-verification.txt`, `negative-verification.json`. Le paquet d’origine et les téléchargements publics sont inchangés. L’ordre alignement puis signature suit la [documentation officielle apksigner](https://developer.android.com/tools/apksigner).

## Recette de démarrage séparée

CircleCI **158 a réussi à 01 h 42** sur la source de recette `97c996ff315b658994e85853e5ff2fd4b1990954`. Le contrôle renforcé **159 a réussi à 01 h 49** sur `6ee54234`, avec un nouveau nom de capture à chaque inspection : un ancien écran ne peut pas faire passer un redémarrage en cas d’échec d’UIAutomator. Les jobs utilisent une machine Android et une image Google APIs x86_64 avec traduction ARM ; ces capacités sont documentées par [CircleCI](https://circleci.com/docs/guides/execution-managed/android-machine-image/) et [Android](https://android-developers.googleblog.com/2020/03/run-arm-apps-on-android-emulator.html).

La recette télécharge le paquet non signé exact du job 157 et lui applique un certificat **jetable propre à l’émulateur**. Tous les fichiers applicatifs doivent rester identiques. Elle ne reçoit pas l’identité de signature persistante et ne publie aucun APK. Elle teste un émulateur neuf, sans compte ni données réelles : introduction, accès au premier écran de configuration, fermeture/relancement, intégrité SQLite et stabilité de l’identité locale protégée.

Les deux recettes prouvent l’installation du contenu optimisé, l’ouverture de l’introduction, le bouton de démarrage, l’accès à la configuration du compte et le relancement. SQLite reste au schéma 60, intègre, sans erreur de clé étrangère ; l’identité chiffrée est identique avant/après. Aucune entreprise ni compte créé, aucune connexion extérieure effectuée. Captures enregistrées et inspectées. Preuves : `outputs/android-release-candidate-20260927/job{158,159}/`.

Le contrôle d’accessibilité obtient son premier écran exploitable après environ **128 secondes**, avec plusieurs réponses « null root node » de l’outil Android. L’activité native est annoncée affichée après 5,9–6,3 secondes, mais cela ne prouve pas une interface utilisable à ce moment. Ce délai mêle premier lancement, émulation et inspection : **ne pas annoncer une performance de démarrage Android à partir de ces seuls nombres**. La recette suivante ajoute une capture immédiate indépendante pour distinguer les causes.

Le reçu de signature locale n’affirme pas que le paquet signé avec l’identité persistante a été installé : la recette distante utilise un certificat jetable. Il reste à tester le certificat de préversion sur un appareil, la mise à jour depuis l’APK public et les parcours connectés.

## Défauts trouvés et corrigés dans la source

La capture native de 320 × 640 montre un chevauchement du nouveau logo et des choix de langue/thème. Sur mobile, le logo a désormais sa propre ligne et les préférences restent dans le flux du document, avec des contrôles de 44 px minimum et une police de 16 px. Les captures de confirmation ont aussi permis de supprimer un rectangle sombre parasite derrière la connexion et de traduire « Créer une entreprise », encore français dans les autres langues.

L’introduction applique temporairement un thème natif sombre pour rendre la barre système lisible. La sortie restaure la préférence actuelle, sans modifier le choix enregistré. Deux nouveaux tests contrôlent cette restauration, les changements de préférence pendant l’introduction et les présentations imbriquées. **Le changement de barre système reste à confirmer dans le nouveau binaire Android.**

Validation du correctif : 14 tests ciblés réussis, huit parcours Chromium/WebKit (320, 390 et 1 440 px ; FR/DE/IT/EN ; clair/sombre ; insets simulés), création locale toujours accessible, TypeScript/build réussis. Les captures finales ont été relues. Le détecteur de design relève 35 conseils sur le style existant, aucun niveau bloquant ; il ne vaut pas validation de tous les écrans.

Source applicative corrigée **`68b1d2974feb887ad98d6cec795a836a8fbd790a`** ; **CircleCI 160 en cours à 01 h 53**, compilation Android optimisée de toutes les dernières sources. Ne pas confondre cette compilation avec le paquet antérieur 157 déjà essayé. Les tests navigateur utilisent des données fictives et ne prouvent pas le nouveau rendu natif.

## Durée de l’introduction sur appareil lent

Le délai relevé sur l’émulateur a conduit à un défaut réel dans `OnboardingIntro.tsx` : l’horloge ne comptait au maximum que 64 ms par image. À une image par seconde, une séquence prévue pour 7,8 secondes pouvait ainsi durer plus de deux minutes. Le correctif compte le temps réel entre les images ; le passage en arrière-plan continue de suspendre la séquence, sans compter le temps caché.

Une contre-épreuve navigateur limite réellement chaque callback à une image par seconde. Avant correction, elle expire après douze secondes sans atteindre le bouton de démarrage. Après correction, la configuration est accessible : **10 072 ms observées, dix appels au maximum par callback, intervalle minimal 1 000,5 ms**. Ces chiffres incluent le premier callback retardé et l’observation du navigateur ; ce ne sont pas des mesures d’appareil physique. Le test compte les callbacks séparément, car plusieurs animations et le contrôleur peuvent demander une image simultanément.

Trois parcours de régression passent : 1 293 px, 390 px et réduction des animations. Les deux parcours animés passent la citation, le logo, le démarrage, le saut au clavier, la relecture, le retour et la connexion fictive ; l’animation s’arrête au repos. Captures relues. Preuves : `desktop/.qa/onboarding-slow-frames/`, journaux `onboarding-slow-frames-{baseline,fixed}.log` et `desktop/.qa/onboarding-arrival/motion-results.json`.

La contre-épreuve complémentaire suspend le document pendant 5,2 secondes, puis le reprend : la séquence reste à la même phase pendant la suspension, ne saute pas à la fin à la reprise et se termine ensuite normalement. Il s’agit d’un événement de visibilité simulé, pas d’un essai de mise en veille physique. Journal `onboarding-slow-frames-visibility.log`, dernière contre-épreuve à faible cadence : 10 076 ms observées.

**Ce correctif d’horloge est postérieur au job 160.** Le job **161**, source **`a5bd668af375a47f08b70c77518ff7fdb58d43d8`**, est confirmé en compilation à 02 h 07. Il inclut la correction ; le job 160 conserve son rôle de validation du lot précédent. Aucun des deux n’est encore déclaré testé sur émulateur.

## Suite de la recette, 28 septembre à 02 h 43

Les compilations **160 et 161 ont réussi**. Leurs APK non signés font chacun 39 763 883 octets ; empreintes respectives `e108ced9f6c388d7674bf1705087ce0af8722d34f8c5e80162afb2da613cb411` et `7bd02f2025bd057f481424caff5ae0515366ee70f49fb155db63e908bd352344`. Les sources et empreintes sont recoupées avec les reçus CI. Le manifeste et les bibliothèques 16 Ko de 160 ont également été revérifiés localement.

**La recette 162 a échoué**, à 02 h 23, sur le paquet 160. Elle confirme par captures natives le logo sans chevauchement, les thèmes clair/sombre et le contraste des barres système. Elle atteint la saisie d’identité, mais le clavier couvre le champ : celui-ci reste à `[24,584][296,637]` dans un écran de 320 × 640. Le texte injecté par ADB est partiel ; cette injection rapide ne permet pas d’attribuer séparément une perte de caractères au produit. L’ancienne horloge explique encore l’introduction très longue dans ce paquet, qui précède sa correction. Aucun succès du parcours complet ou du redémarrage n’est attribué à 162.

Attention au diagnostic des fenêtres : la fenêtre **Zentra** indique `adjust=pan` ; la fenêtre `adjust=nothing` est celle du lanceur Android. La correction `643670acac79d24c23d29678e0732b39f7687c26` utilise `adjustResize` et un conteneur natif qui applique les insets clavier/barres/encoche. Les insets traités sont ensuite transmis à zéro au WebView pour éviter un double espacement ou un espace restant après fermeture du clavier, conformément à la [documentation Android](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets). La compilation **163 est en cours** ; cette correction n’est pas encore déclarée validée à l’exécution.

La recette renforcée doit capturer le fournisseur WebView et la densité, attendre le clavier effectif, comparer les coordonnées du champ à l’inset IME fourni par Android, saisir un marqueur sans rafale ADB, puis vérifier le retour aux dimensions précédentes. Un test négatif rejette les coordonnées du défaut reproduit ; les cinq tests des contrôleurs passent. Les données restent fictives, sans connexion de compte ni création d’entreprise.

Preuves de la recette échouée : `outputs/android-release-candidate-20260927/job162/`, captures `02-account-Clair.png`, `02-account-Sombre.png`, `05-identity-keyboard.png` et leurs arbres d’accessibilité. Les états « en cours » des sections précédentes décrivent leur instant historique, pas le statut actuel ci-dessus.

## Résultat du correctif clavier et limite visuelle suivante

**Compilation 163 réussie à 02 h 47, recette 164 réussie à 02 h 55.** Source applicative `643670acac79d24c23d29678e0732b39f7687c26`, source de recette `1372c03d7cd00622bec0699a6399279e0c854fa4`. APK non signé : 39 763 883 octets, SHA-256 `47b8f7974a507a8754d13278c560f0304ce63f89173bcbee20995705797c01bf`. Le DEX et la bibliothèque native diffèrent bien du paquet 160 malgré une taille d’archive identique.

La signature locale persistante est vérifiée : 39 846 622 octets, SHA-256 `a5e5cef7a0c7561c345d0a39ec2e6aecc0625aa86112545a6f467aefbe7096a9`, même certificat épinglé, 964 entrées applicatives identiques, alignement 16 Ko. La recette distante conserve son certificat jetable ; elle ne prouve pas l’installation du fichier local signé avec l’identité persistante.

Émulateur 320 × 640, densité 160, WebView **124.0.6367.219**. Avant et après saisie du marqueur, champ `[24,310][296,363]`, WebView `[0,24][320,381]`, clavier commençant à **381**. Le texte `Zentra-Test` est conservé. Le viewport reprend ses dimensions après fermeture du clavier. Retour au compte et redémarrage passent ; SQLite reste au schéma 60, intègre, sans erreur de clé étrangère, avec identité protégée identique. Aucun compte connecté ni entreprise créée.

L’interface de bienvenue est obtenue après 71 110 ms d’observation, incluant les délais de deux inspections UIAutomator sans racine. La capture intermédiaire montre encore l’introduction. Cette mesure ne permet pas d’isoler la durée native de l’animation ou de promettre un temps de démarrage physique ; seule la correction d’horloge est isolée par la contre-épreuve navigateur précédente.

**Le passage fonctionnel ne suffisait pas à valider le thème.** Les captures 164 montrent du blanc dans les marges natives, avec icônes claires en mode sombre. La correction `5b88d22fbf360d91fc6ea31fb9430bcb550ff8d5` colore le conteneur natif d’après le `theme-color` clair/sombre utilisé par l’app ; compilation 165 lancée à 02 h 58. Le nouvel examen des pixels rejette réellement la capture sombre 164 et accepte sa capture claire. Il vérifie aussi les indicateurs natifs de contraste des icônes, pas uniquement la sélection du menu. Sa confirmation sur le nouveau binaire reste à faire.

Preuves : `outputs/android-release-candidate-20260927/job163/signed/` et `job164/`, notamment `proof.json`, `webview-provider.txt`, les captures de saisie et les deux thèmes. Le journal natif ne contient pas de plantage de Zentra identifié par les recherches FATAL/ANR/panic ; cela n’est pas une preuve d’absence de tout défaut.

## Limites de livraison

Le candidat 157 précède plusieurs corrections locales récentes, dont les périodes comptables et les performances des gros historiques. Le candidat 160 les inclut mais précède la correction d’horloge ci-dessus. Leur numéro technique 1.90.6 ne doit pas remplacer les fichiers publics de même version. La future livraison doit regrouper les sources finales sous un nouveau numéro. Ni installation chez le client, ni publication Play Store, ni validation physique n’est annoncée.
