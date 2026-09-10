# Zentra : rendre la gestion financière compréhensible

Recherche et décisions d’interface — 10 septembre 2026. Public visé : responsable d’une petite entreprise suisse, sans formation comptable, sur Windows et téléphone. Livrable principal : intégration dans l’application ; ce document conserve les sources et les limites.

## Résultat de la recherche

Le problème observé dans Zentra est surtout l’ordre de présentation. Le journal, le plan comptable, les méthodes fiscales et leurs exceptions apparaissent avant les tâches quotidiennes. La première vue doit répondre à trois questions : quels chiffres sont disponibles, que signifient-ils et quelle action effectuer ensuite ? Les fonctions détaillées restent nécessaires à la fiduciaire et aux corrections.

Cette conclusion est une **inférence de conception**, fondée sur l’inspection de l’application et les références ci-dessous. Elle n’est pas le résultat d’entretiens avec des clients. Les contrôles automatisés et visuels vérifient le fonctionnement et la disposition ; ils ne mesurent pas encore la compréhension par un utilisateur novice.

## Principes et applications

| Référence primaire consultée | Enseignement retenu | Intégration |
| --- | --- | --- |
| [Apple — Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding) | Introduire les fonctions utiles au moment pertinent ; permettre de reprendre l’aide. | Bouton « Comprendre cet écran » sur chaque module, avec trois actions concrètes et un conseil. Le tutoriel complet reste accessible. |
| [GOV.UK — Question pages](https://design-system.service.gov.uk/patterns/question-pages/) | Demander les informations nécessaires dans un ordre clair et réutiliser ce qui est déjà connu. | Configuration des délais en deux étapes : choix, puis vérification. Les coordonnées et les autres paramètres ne sont pas ressaisis. |
| [GOV.UK — Check answers](https://design-system.service.gov.uk/patterns/check-answers/) | Montrer les réponses avant la confirmation et permettre leur correction. | Comparaison des délais actuels et proposés ; récapitulatif du profil TVA avant l’enregistrement. |
| [GOV.UK — Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/) | Réduire d’abord le nombre de tâches ; regrouper les actions liées et distinguer ce qui reste à faire. | Accueil comptable centré sur résultat, TVA, bilan et clôture. Journal, grand livre et liaisons dans un choix d’outils détaillés. Pas de nouvelle checklist obligatoire pour consulter des chiffres. |
| [Apple — Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Les matériaux servent la hiérarchie et la lisibilité du contenu. | Surfaces sobres, contrastes stables, navigation active claire, tableaux opaques et lisibles. La version Windows n’est pas présentée comme une implémentation des contrôles Liquid Glass natifs d’Apple. |
| [W3C — WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Prévenir les erreurs sur les données financières, permettre le redimensionnement et l’usage au clavier. | Choix explicites, retour avant validation, blocage du double envoi, conservation des choix après erreur, focus visible, menus adaptatifs, réduction des animations. Cela ne constitue pas une certification d’accessibilité complète. |

Le style conserve la palette de Zentra : vert pour les actions, texte sombre, fonds clairs. La hiérarchie repose sur la typographie, l’espacement et des libellés concrets. L’information comptable reste alignée et les montants utilisent des chiffres à largeur régulière. Les transitions sont courtes ; elles disparaissent avec la préférence de réduction des mouvements.

## Expliquer les montants sans les déformer

Un résultat comptable et une trésorerie disponible répondent à des questions différentes. Le Portail PME insiste sur la planification des entrées et sorties pour couvrir les échéances ; on ne peut donc pas présenter un bénéfice comme un montant immédiatement disponible à dépenser. [Portail PME — Liquidity planning](https://www.kmu.admin.ch/content/kmu/en/home/concrete-know-how/finances/accounting-and-auditing/financial-planning/liquidity-planning.html).

Dans Zentra :

- « Factures émises · TTC », « Paiements reçus » et « Reste à recevoir » expliquent les indicateurs de ventes. Une aide précise leur périmètre et sépare les devises.
- L’accueil comptable affiche les revenus, les charges et le résultat issus des états existants. Aucune somme n’est fabriquée à partir d’indicateurs commerciaux.
- Une comptabilité non préparée ne présente pas un faux résultat nul. Un chargement, un état absent ou plusieurs devises sans conversion produit une explication et un montant indisponible.
- Le résultat, le bilan, le grand livre, la balance et la clôture ont chacun une explication courte avant les détails.
- Les raccourcis mensuel, trimestriel, annuel et toutes dates règlent les filtres existants. Ils ne créent pas un exercice et ne clôturent rien.

Les obligations de tenue des comptes dépendent notamment de la forme juridique et de la taille de l’entreprise. Le Portail PME distingue la comptabilité complète et les obligations minimales de certaines entreprises individuelles et sociétés de personnes. Un assistant ne peut donc pas décider du régime légal uniquement à partir du secteur d’activité. Zentra conserve les états comptables et propose les comptes de base existants après confirmation ; leur activation ne vaut pas validation des obligations propres à l’entreprise. [Portail PME — Comptabilité obligatoire](https://www.kmu.admin.ch/fr/comptabilite-obligatoire-lobligation-de-tenir-une-comptabilite).

## Configuration prête à choisir

### Conditions commerciales

Trois propositions : paiement à 14 jours et devis valable 30 jours ; 30/30 ; 60/60. Ce sont des **choix de produit à convenir avec les clients**, pas des délais imposés par le droit suisse. L’application compare les deux valeurs avant d’enregistrer. Les documents existants, la numérotation, l’IBAN, l’assujettissement et les paramètres de paie sont conservés. Les réglages sont relus avant l’application afin de préserver les changements intervenus depuis l’ouverture de la fenêtre.

### TVA

La TVA suisse prévoit les taux légaux normal, réduit et spécial ; le choix applicable dépend de la prestation. La déduction de l’impôt préalable ne concerne que les achats ouvrant droit à déduction et suppose le traitement approprié. Un taux unique appliqué à tous les secteurs ne simplifierait pas correctement le calcul. [AFC — Taxe sur la valeur ajoutée](https://www.estv.admin.ch/fr/taxe-sur-la-valeur-ajoutee).

Le fonctionnement du contrôle TVA lie le décompte aux pièces comptables et au mode de prise en compte : facturation ou encaissements. Le système doit conserver ces distinctions et les changements datés de méthode. [AFC — Déroulement d’un contrôle TVA](https://www.estv.admin.ch/fr/deroulement-dun-controle-tva).

Les propositions préparent le formulaire existant :

| Proposition | Valeurs préparées | Ce que la personne doit confirmer |
| --- | --- | --- |
| TVA sur les factures | Effective, contre-prestations convenues, trimestre, présentation nette | Mode réellement appliqué, dates et autres choix du dossier AFC |
| TVA sur les paiements | Effective, contre-prestations reçues, trimestre, présentation nette | Autorisation applicable, dates et continuité des comptes nécessaires |
| Taux d’activité AFC | TDFN/TaF, contre-prestations convenues, semestre, présentation brute | Activité, taux approuvé, périodicité et autorisation correspondant à sa situation |

La proposition TDFN/TaF n’invente aucun taux d’activité. L’impôt préalable est pris en compte forfaitairement dans cette méthode et ne se déduit pas séparément ; les factures aux clients conservent les taux légaux applicables. Un changement de méthode implique des conditions et adaptations à vérifier. [AFC — Taux de la dette fiscale nette et taux forfaitaires](https://www.estv.admin.ch/fr/tva-taux-de-la-dette-fiscale-nette-et-taux-forfaitaires).

Les propositions ne déclarent pas une entreprise assujettie, n’enregistrent pas un profil d’un simple clic et ne cochent pas l’autorisation à la place de l’utilisateur. Le récapitulatif affiche méthode, moment de prise en compte, dates, fréquence, taux d’activité éventuel et fermeture éventuelle du profil précédent. Les validations natives, notamment sur les changements incompatibles avec les soldes ouverts, restent actives.

## Limites et vérification

Le changement porte sur la présentation, les explications et les formulaires qui utilisent les commandes existantes. Il n’ajoute ni transmission ELM/Swissdec, ni nouvelles règles de calcul par canton, ni certification fiscale. L’autorisation AFC, l’assujettissement, les taux d’assurance et les décisions de clôture restent des informations propres à chaque entreprise.

La version Windows est construite sur le schéma distribué 59. Les migrations de synchronisation et les nouveaux calculs de paie en préparation sont conservés dans leur copie de travail et ne font pas partie de ce lot. Les preuves de compilation, de signature, les tests et le statut de distribution sont consignés séparément dans `RELEASE-1.48.md` après leur réalisation.

Pour une prochaine validation avec des clients, observer sans guider quatre tâches : trouver le montant encore dû par les clients, expliquer la différence entre résultat et banque, préparer les délais de facturation, puis choisir le profil TVA à partir d’un dossier AFC fictif. Mesurer les hésitations, les erreurs et les demandes d’aide avant de modifier les libellés.
