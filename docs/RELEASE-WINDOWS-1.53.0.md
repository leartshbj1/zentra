# Windows 1.53.0 — Reprendre une fiche après correction

## Problème reproduit

Sur la version 1.52.0, après correction du salaire annuel LPP depuis le récapitulatif, le calcul était invalidé et « Enregistrer la fiche » désactivé. Aucun bouton de recalcul n’était visible. La correction exigeait de revenir manuellement à l’étape précédente. Certaines erreurs annuelles étaient orientées à tort vers la pension.

## Comportement

- Après une modification des réglages, le récapitulatif explique ce qui reste à faire. Le bouton principal devient « Recalculer le salaire », puis « Enregistrer la fiche » après contrôle. Le premier clic ne sauvegarde pas automatiquement.
- Les cotisations du profil qui ne sont pas encore dans la fiche peuvent être ajoutées depuis le récapitulatif. Cette action explicite conserve les cotisations et bases manuelles déjà choisies.
- Une base effacée reste inconnue, au lieu de devenir silencieusement zéro.
- Les champs invalides sont nommés, marqués pour les lecteurs d’écran et accessibles directement, même dans une rubrique repliée. Les formulaires de salaire, contrat et cotisation utilisent la même aide.
- La date de choix des petits salaires ouvre « Début d’année », avec le champ et le document à utiliser. La validation annuelle utilise le même parseur que la création du collaborateur.
- Les problèmes connus proposent des guides par étapes et les réglages correspondants. Les pannes temporaires proposent de réessayer, sans conseiller une modification des assurances.

## Vérifications

84 tests unitaires ciblés réussis : orientation, profils, calcul périmé, annualité et contexte assistant. Compilation TypeScript réussie.

Recette `payroll-repair-journey.mjs` : Edge et WebKit, 390 et 1440 px. Base effacée, retour au champ, date annuelle invalide puis correction, recalcul, enregistrement et conservation du salaire, des notes et d’une base manuelle.

Recette `payroll-pension-corrections-journey.mjs` : 320, 390, 1440 px. Salaire annuel, contrat de pension incomplet puis corrigé, deux parts mensuelles, ajout depuis le récapitulatif, correction comptable, recalcul et sauvegarde.

Ces recettes utilisent des données synthétiques. Elles ne constituent pas une certification de paie, une preuve d’installation native ou une mise à niveau réelle d’un profil client. Aucun changement des taux, règles cantonales ou écritures du moteur natif dans cette version.

## Références de l’aide

Consultées le 11 septembre 2026 : [mémento AVS, petits salaires](https://www.ahv-iv.ch/p/2.04.f), [OFAS, financement de la prévoyance professionnelle](https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle). Les primes restent celles des contrats ; le choix annuel et ses justificatifs ne sont jamais inventés.

## Publication

Compilation et publication en cours. Les preuves de l’artefact et du manifeste seront ajoutées après vérification publique. Pas de publication macOS/iOS dans cette livraison Windows.
