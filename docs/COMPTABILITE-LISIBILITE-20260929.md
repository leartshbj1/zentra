# Comptabilité — lisibilité avec texte agrandi

Correctif local postérieur à la source publiée 1.90.9. Présentation existante conservée ; aucun calcul ou action métier modifié.

À 390 px avec texte à 200 %, la ligne d'introduction réservait toute la largeur au bouton « Configurer simplement » : l'explication ne gardait que 28,33 px et occupait 688 px de hauteur. Une base de flexion liée à la taille du texte fait maintenant passer le bouton sur la ligne suivante avant de comprimer l'explication. Sa largeur maximale reste bornée au conteneur, sans réduire la taille choisie par l'utilisateur.

Après correction, cette explication occupe 350 px de large sur 44 px de haut. Le titre agrandi conserve sa taille et demande la césure automatique selon la langue ; les moteurs Windows utilisés n'ajoutent pas de césure visible à Comptabilité/Buchhaltung. Les coupures des titres et les textes comptables encore français dans d'autres langues restent donc des points distincts à traiter, sans validation globale implicite.

## Vérification

`desktop/tests/accounting-readable-layout.mjs` utilise les vrais composants avec données natives fictives et interdit les requêtes externes. Cinq configurations passent : Edge 1440 FR clair/100 %, WebKit 390 IT clair/100 %, WebKit 390 FR sombre/200 %, WebKit 320 DE clair/200 %, Edge 844×390 EN sombre/200 %. Contrôles : largeur et hauteur lisibles de l'explication, absence de débordement horizontal, bouton de configuration accessible, ouverture/fermeture de l'explication puis du dialogue de configuration. Aucun message d'erreur JavaScript dans ces parcours.

Une inspection initiale et une confirmation après le seul lot CSS ; les dix captures et mesures sont dans `desktop/.qa/accounting-readable/`. Le premier lancement du vérificateur corrigé s'arrêtait sur `line-height: normal` : son calcul a été rendu explicite, sans modification supplémentaire de l'interface. La géométrie des titres mesurée ne vaut pas preuve de césure effective ou d'accessibilité globale. Les gestes physiques, lecteurs d'écran et moteurs natifs restent à contrôler.

Le détecteur exécuté une fois sur les deux feuilles CSS ne signale aucun défaut principal, mais 22 avis sur des valeurs préexistantes de leur système de styles. Ces valeurs et le décalage déjà signalé entre DESIGN.md et son index ne sont pas réécrits dans ce correctif.

Reproduction depuis `desktop`, serveur Vite local 5377, module Playwright disponible :

```powershell
node tests/accounting-readable-layout.mjs
```

L'option `--before` est réservée au témoin avant correction ; ne pas écraser les mesures initiales avec la source corrigée.
