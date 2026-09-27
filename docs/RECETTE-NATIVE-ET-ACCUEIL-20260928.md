# Recette Windows de la source et correction de l’accueil

28 septembre 2026. Complément à l’audit du premier client ; aucun nouveau paquet public.

## Application native effectivement exécutée

Source `a46085d977812ba1fd64d4344926e2caef1b64fc`, après les corrections du guide et des langues des rapports. Compilation locale Tauri `--debug --no-bundle --ci`, sans installateur, avec le frontend construit. Exécutable SHA-256 `521f2ced17e0fad8745c42717d6330f0d9e7f91f0fa0c394659a8f55e440ac35`. Il porte encore le numéro technique 1.90.6, mais **ce n’est pas le binaire public 1.90.6**. Aucune publication ni installation client.

Le profil et le stockage WebView sont séparés. La base copiée est celle d’« Atelier Recette 1905 », entreprise fictive ; aucun compte distant, secret SMTP ou fichier de session n’est copié. Le premier lancement, dont le lanceur n’était pas maintenu ouvert, ne sert pas de preuve de navigation. Le second lanceur reste actif pendant les essais ; l’application est ensuite fermée normalement, code de sortie 0 à 00 h 29.

- 14 écrans × 3 passages : 42 navigations natives, sans erreur JavaScript ni débordement horizontal global détectés.
- La mesure finale attend le contenu après le titre et la disparition des chargements : médiane **47 ms**, p95 **444 ms**, maximum **478 ms**. Une tâche JavaScript de **69 ms** observée ; pas de promesse « aucun blocage ».
- La première passe ne mesurait que l’arrivée de l’en-tête ; ses chiffres sont conservés séparément et ne sont pas retenus comme temps de disponibilité du contenu.
- 16 étapes du guide complet consultées, fermeture par Échap et retour au bouton d’aide vérifiés.
- Captures des menus et du guide examinées. La capture de l’accueil a révélé le défaut de colonne vide corrigé ci-dessous.
- Avant/après démarrage, navigation et fermeture : **110 tables comparées, 17 remplies, trois fichiers**, empreintes métier identiques. SQLite et clés étrangères intègres ; écritures équilibrées. Toujours 1 000 CHF facturés, 250 CHF reçus, 750 CHF restant et 5 000 CHF de brut fictif.
- L’exécutable installé reste 1.90.5, SHA-256 `acdf4cbd259508a478fcebfbad6af2516a4bec86da6be0278739ce077d1bdc61`.

Ces résultats portent sur un petit dossier local en mode debug. Ils ne valident ni installation du paquet public, démarrage à froid mesuré, grosse entreprise, performances mobiles, compte, messagerie, Automation autorisée ou synchronisation réelle. Le refus Code Integrity de l’installateur public reste distinct et non résolu.

Preuves : `outputs/native-source-smoke-20260928/{process,relaunch-process,exit,navigation,before-snapshot,final-closed-snapshot}.json`, scripts `profile-check.py` et `navigation.mjs`, captures `screen-01.png` à `screen-14.png`, `guide-complete.png`, journaux de compilation. L’état observé dans ces captures précède le correctif suivant.

## Correctif issu de la revue de l’accueil

La grille gardait sa colonne Automation quand aucun résumé n’était présent. Sur ordinateur, « À suivre » prend maintenant toute la largeur dans ce cas. Avec Automation, le résumé et le suivi conservent leurs deux colonnes ; la composition mobile reste distincte.

Les libellés du suivi utilisent les traductions déjà présentes et sa date suit la langue choisie. À 150–200 %, les montants disposent de deux colonnes, ou d’une seule sur les largeurs intermédiaires, pour éviter de séparer la partie décimale. Le nom de produit dans le rail et les actions d’en-tête peuvent revenir à la ligne au lieu de déborder.

**20 configurations navigateur finales passent** : Chromium et WebKit, Automation active/inactive, 390/1 024/1 440 px, FR/DE/IT/EN, clair/sombre et texte 100/200 %. Vérification de la largeur réellement occupée, de l’absence de coupure dans les montants de la fixture, des libellés traduits, des actions visibles et du rail. Captures relues. Deux tests de couverture des traductions, TypeScript, 50 actifs de marque et build passent ; l’avertissement existant sur certains blocs JavaScript de plus de 500 ko demeure.

Preuves : `desktop/.qa/dashboard-without-automation/report.json` et captures ; `outputs/native-source-smoke-20260928/dashboard-{layout-final,build-final,unit}.log`. Ce dernier ajustement n’est pas inclus dans le binaire debug `a46085d9` ci-dessus ; il est validé en navigateur, **pas encore recompilé dans un binaire livré**.

## Service de compte

À **00 h 38**, connexion fictive sans cookie à une adresse inexistante : HTTP **503**, `Retry-After: 60`, `Cache-Control: no-store, max-age=0`, message d’authentification temporairement indisponible. Aucun compte créé ni e-mail envoyé. Preuve `auth-readiness.json`. Le contrôle direct de quotas Supabase de la veille à 20 h 05 n’a pas été répété ici : il indiquait alors stockage et transfert dépassés. La recette connectée reste ouverte.
