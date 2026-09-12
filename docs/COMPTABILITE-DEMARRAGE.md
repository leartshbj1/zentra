# Préparer les comptes dans Zentra

Depuis **Comptabilité**, ouvrez **Préparer les comptes** ou **Vérifier ma configuration**. Vous arrivez dans **Plan & liaisons**.

## Démarrer avec les comptes de base

Si aucune configuration et aucune écriture comptable n’existent, **Installer la base essentielle** prépare le démarrage. Une fenêtre explique les effets avant toute modification : création ou réutilisation des 12 comptes prévus par Zentra, association aux ventes, achats, banque, TVA et salaires, puis activation.

L’activation intègre aussi les opérations historiques manquantes des périodes ouvertes. Les opérations des périodes fermées sont signalées pour une reprise contrôlée des soldes d’ouverture. Elles ne sont pas déplacées dans l’exercice courant. La confirmation présente les compteurs disponibles avant l’enregistrement, puis le résultat effectivement renvoyé par le moteur.

Cette base reste à adapter à l’activité avec votre fiduciaire. Un compte existant portant le même code mais une définition différente bloque l’installation ; Zentra ne remplace pas silencieusement le plan existant. Une fois la comptabilité configurée, utilisez les comptes de liaison pour la modifier.

## Utiliser votre plan existant

Les comptes de liaison sont regroupés en **Ventes et banque**, **Achats et fournisseurs**, **TVA**, puis **Salaires et cotisations** lorsque ces derniers sont requis. Chaque champ explique ce qu’il représente. Les listes proposent uniquement les comptes actifs du type attendu ; un ancien choix devenu incompatible reste identifié comme un compte à remplacer.

Le moteur indique les besoins à l’écran :

| Situation enregistrée dans l’entreprise | Comptes nécessaires |
| --- | ---: |
| Sans paie requise et sans profil de TVA sur les encaissements | 7 |
| Sans paie requise, avec un profil de TVA sur les encaissements | 8 |
| Paie requise, sans profil de TVA sur les encaissements | 11 |
| Paie requise, avec un profil de TVA sur les encaissements | 12 |

Un ancien profil de TVA sur les encaissements reste pris en compte. Si aucun profil de ce type n’existe, **TVA en attente d’encaissement** peut rester vide. Un compte facultatif déjà sélectionné est néanmoins vérifié. Les exigences comptables ne constituent pas une décision d’assujettissement à la TVA.

**Vérifier avant d’enregistrer** ouvre le premier champ à corriger et y place le curseur. Il faut notamment distinguer la banque, les créances clients et la TVA préalable, ainsi que la TVA due et la TVA en attente. Si un compte manque, **Créer un compte manquant** ouvre le plan comptable sur le formulaire. Les choix de liaison en cours restent conservés après cette création.

Relisez ensuite le récapitulatif et confirmez **Enregistrer ces réglages**. Un refus laisse les choix présents. Le plan complet reste disponible dans **Voir et modifier le plan comptable**.

## Après l’enregistrement

La fenêtre indique les écritures intégrées, les opérations de périodes fermées à reprendre et les points de contrôle restants au moment de l’enregistrement. Ces derniers demandent un examen ; l’activation ne les résout pas nécessairement.

Si la lecture des données ou des états échoue après un enregistrement confirmé, **Actualiser les données** relit les comptes, l’espace de travail et les rapports. Cette action ne renvoie pas la commande de configuration ou d’installation. Elle reste utilisable en lecture seule. La fenêtre empêche les doubles validations pendant le traitement.

Quand des écritures existent, la comptabilité active ne peut plus être désactivée. Les comptes de liaison peuvent être corrigés pour les opérations futures ; l’historique comptable demeure traçable.

## Portée technique

Les exigences sont ajoutées au rapport de continuité natif ; aucun schéma ni calcul fiscal n’est modifié. Si une ancienne réponse native ne les fournit pas, l’interface conserve la vérification de TVA différée et le besoin de paie connu localement, avec une explication visible.

Les recettes utilisent des données synthétiques, le moteur SQLite et des navigateurs aux formats mobile et ordinateur. Elles n’attestent pas une certification fiscale, une installation sur iPhone ni une publication de binaires.
