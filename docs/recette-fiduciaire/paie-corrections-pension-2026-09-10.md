# Corrections guidées de la pension et de la paie

La création de salaire distingue désormais trois corrections : salaire annuel du collaborateur, contrat de la caisse de pension, montants des cotisations. Les messages conduisent au formulaire concerné, avec ouverture de la section et mise au point du champ. Le formulaire du salaire reste monté : montants, personne, mois et notes sont conservés.

Le mot « couverture » correspondait par erreur à la recherche « ouverture » et ouvrait les cumuls de début d'année. Le contrôle utilise maintenant le mot complet. Les erreurs de comptes de salaire conduisent à un formulaire limité aux deux comptes concernés ; les autres choix comptables sont conservés et relus avant modification. Les réglages particuliers de cotisation sont accessibles sans fermer le salaire.

## Pension

Le guide présente le salaire annuel annoncé, le contrat et les deux parts mensuelles. Le nom d'une caisse seul ne constitue pas un contrat complet. Le contrat exige numéro, référence, dates réelles et confirmation de la participation employeur. Les informations déjà confirmées préremplissent la référence et les dates des nouvelles cotisations. Aucun montant, taux ni exception n'est inventé.

Une aide explique les documents à demander à la caisse. La retraite et les exceptions documentées peuvent être complétées dans le même parcours. Les décisions d'assujettissement, les calculs et les validations du moteur natif sont conservés.

Source officielle vérifiée le 10 septembre 2026 : [OFAS — Financement de la prévoyance professionnelle](https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle). Les contributions dépendent du plan ; la participation minimale employeur est appréciée sur l'ensemble des cotisations des employés. Le logiciel ne dispose pas d'un montant universel LPP à appliquer.

## Vérification locale

- 1 015 tests d'interface réussis dans la copie de développement ; TypeScript et lint des composants concernés passent.
- 15 nouveaux contrôles vérifient les destinations, la séparation des erreurs LPP et les contrats incomplets ou périmés.
- Parcours avec données fictives en 320, 390 et 1440 pixels : salaire annuel manquant, ouverture ciblée de la pension, contrat incomplet refusé sans perte de saisie, deux parts LPP distinctes, recalcul, erreur de compte, correction puis enregistrement.
- Parcours de régression des contrats, assurances, cumuls et taux exacts conservé en trois largeurs et avec référentiel fédéral initialement vide.
- Les essais n'utilisent aucune donnée réelle ni écriture dans le dossier de l'utilisateur.

Preuves : `desktop/.qa/payroll-pension-corrections/`, `desktop/.qa/payroll-simple/`. Le portage Windows 1.50 utilise le moteur et le schéma 59 inchangés de 1.49 ; il dispose de sa propre recette dans sa copie de publication.
