# Ouverture Zentra — 25 septembre 2026

Le premier écran a été remplacé à la demande de l’utilisateur, qui jugeait le guide précédent trop administratif. La configuration complète et son guide restent disponibles après la connexion.

## Expérience

- Une citation, un mouvement de filaments lumineux et des particules qui rejoignent les pixels du vrai logo Zentra. La séquence dure 7,8 secondes, sans son ni dépendance d’animation supplémentaire.
- « Passer l’introduction » reste accessible pendant la séquence. Le démarrage suivant et le retour depuis la connexion affichent directement le logo. « Revoir l’introduction » relance volontairement la séquence.
- La préférence de réduction des animations affiche directement la composition finale. Le canvas suspend ses images lorsque la page est cachée et cesse de dessiner au repos.
- La connexion a désormais son propre écran, un bouton principal sur toute la largeur, puis les chemins invitation, sauvegarde et création locale. La fenêtre de connexion sécurisée et les commandes natives sont conservées.
- La configuration retrouve son guide à partir de l’entreprise. Champs plus souples, titres plus aérés, choix du thème et de la langue, quatre traductions et sauvegarde du brouillon conservés.

La citation est un court extrait du discours de Steve Jobs à Stanford du 12 juin 2005, traduit en français, allemand et italien. Source : https://news.stanford.edu/stories/2005/06/youve-got-find-love-jobs-says. Le logo provient de l’asset existant `desktop/src/assets/zentra-wordmark.png`. Aucun nouveau fichier image de marque n’a été créé.

## Vérification

Preuves locales dans `desktop/.qa/onboarding-arrival/` :

- `journey-results.json` : 360 combinaisons (15 écrans, 4 langues, 3 largeurs, 2 thèmes), création complète fictive, validation native simulée, nouvelle tentative, brouillon, restauration annulée, assistant et ouverture d’une entreprise déjà partagée.
- `motion-results.json` : séquence complète, arrêt des images au repos, passage au clavier, relecture, retour sans rejouer, connexion, réduction des animations ; Chromium à 1293 et 390 pixels. Les mesures locales ne constituent pas un benchmark d’iPhone.
- `build.log` : compilation TypeScript et Vite réussie ; avertissement préexistant sur la taille de certains modules.
- 21 tests unitaires ciblés réussis : onboardingFlow, onboardingDraft, cloudAccountOpening, companyAccount.
- 21 scénarios d’ouverture de l’application avec passerelle simulée à 320, 390 et 1440 pixels réussis (`desktop/.qa/app-opening/report.json`).
- WebKit : navigation tactile et branche de sauvegarde iOS simulée ; variables d’insets natifs vérifiées à 320 et 390 pixels (`desktop/.qa/onboarding-redesign/ios-platform.json`).

Les captures de phases « quote », « light » et « logo » décrivent intentionnellement des instants de la séquence. « ready » et « account-ready » montrent les écrans au repos. Les fichiers utilisent exclusivement une entreprise fictive et des commandes natives simulées.

La relecture indépendante est consignée dans `desktop/.qa/onboarding-arrival/finish-review.md`. Son verdict `finish-verdict.md` est **ship**, limité aux trois corrections demandées : focus de l’introduction, cohérence entre compteur et barre de progression, et contraste du libellé du code de connexion. Les trois sont jugées résolues, sans régression observée dans ce lot. Le libellé passe à 5,429:1, mesuré sur les pixels de la capture (`label-contrast.json`). Ce verdict ne constitue pas une validation de l’authentification réelle ou d’une installation native.

## Périmètre de livraison

Code commun de l’application et aperçu interactif : `http://127.0.0.1:5331/tests/onboarding-preview.html?intro=1`. Ce paramètre remet uniquement les préférences et le brouillon de l’aperçu fictif à zéro ; l’application réelle ne l’utilise pas. Aucun service d’authentification, abonnement, calcul de paie ni donnée d’entreprise n’est modifié par cette refonte.

Aucun installateur natif n’a été produit ou publié pour cette modification. La version reste 1.86.1. Les tests en navigateur ne prouvent pas une installation Windows, macOS, iOS ou Android.
