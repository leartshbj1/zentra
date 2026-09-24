# Premier démarrage — un guide à vos côtés

Le client prépare son entreprise dans le parcours complet dès le premier démarrage. Le choix confirmé est un guide permanent à gauche sur ordinateur et un sommaire dépliable sur téléphone.

## Parcours intégré

Accueil animé, langue et apparence, compte ou reprise d’une entreprise, identité, adresse, activité, TVA, compte bancaire, documents, organisation du travail, paie et assurances si utilisées, sauvegarde, aides facultatives et récapitulatif. La création utilise toujours la validation complète et les commandes natives existantes. La configuration d’un plan comptable et les réglages propres aux futurs collaborateurs restent dans leurs modules respectifs ; aucun taux d’assurance n’est inventé.

Les champs sont répartis sur 15 écrans (13 si la paie n’est pas utilisée). Le guide propose sept chapitres. Les erreurs dirigent vers leur champ, y compris dans les options dépliables. Le brouillon est enregistré localement, reprend les anciens brouillons et conserve les valeurs avancées. La connexion à une entreprise déjà partagée conserve le mécanisme de résolution des espaces et évite une création supplémentaire.

L’aide est accessible dans l’en-tête pendant la configuration ; son bouton flottant ne masque plus les champs. Le panneau de licence est disponible dans l’étape du compte. Les règles d’accès et les permissions natives sont conservées.

## Validation effectuée

- 1 651 tests frontend réussis, dont cinq nouveaux tests de migration du brouillon et d’orientation vers les champs.
- Compilation TypeScript et Vite réussie. Le warning existant concernant les chunks supérieurs à 500 Ko demeure.
- 360 contrôles d’affichage : 15 écrans, quatre langues, trois largeurs (320, 390 et 1293 px), deux thèmes. Aucun débordement de page ou libellé dans les éléments contrôlés.
- Création complète avec paie, rejet de la validation native simulée, correction, nouvelle tentative, conservation du brouillon après refus d’enregistrement, annulation de restauration, ouverture de l’assistant et récupération d’une entreprise existante sans création supplémentaire.
- 21 scénarios du point d’entrée App : délais, reprise et réponse obsolète, à 320, 390 et 1440 px.
- WebKit tactile : accueil, compte et identité. Une seconde instance compilée pour iOS vérifie que la sauvegarde utilise le partage et ne bloque pas sur un dossier Windows.
- Marges natives injectées (haut 59, droite 28, bas 34, gauche 30 px) respectées à 320 et 390 px. Les actions Choisir, Remplacer et Retirer le logo mesurent au moins 44 px (règle mobile à 46 px).

La revue indépendante a demandé deux corrections : priorité aux marges natives et agrandissement des actions du logo. Son verdict final `ship` note ces deux corrections résolues après nouvelle capture des 15 vues. Ce verdict porte sur les corrections, sans étendre la validation aux installations natives. Rapport et verdict : `finish-review.md` et `finish-verdict.md` dans le dossier de preuves local.

Les API natives des parcours navigateur sont simulées, avec une entreprise fictive. Ces essais ne prouvent ni une installation sur téléphone ni une connexion distante réelle. Aucun compte client, document métier ou profil installé n’a été réinitialisé. Ce lot ne publie pas de nouveaux installateurs ou paquets mobiles.

Preuves locales : `desktop/.qa/onboarding-redesign/` et `desktop/.qa/app-opening/report.json`. Sources centrales : `OnboardingJourney.tsx`, `OnboardingSteps.tsx`, `onboardingFlow.ts` et `onboarding-journey.css`.
