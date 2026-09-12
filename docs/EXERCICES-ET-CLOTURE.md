# Exercices et clôture dans Zentra

## Créer un exercice

Ouvrez **Comptabilité → Dossier de clôture → Choisir ou créer un exercice**, ou utilisez **Exercices** dans les outils comptables.

**Nouvel exercice** propose trois années proches de l’année courante. Toucher une année renseigne son premier et son dernier jour. Vous pouvez aussi saisir directement des dates personnalisées, par exemple du 1er juillet au 30 juin suivant. Un nom déjà personnalisé est conservé lorsque vous choisissez une année.

Les deux dates sont incluses. La création d’un exercice ne verrouille pas les comptes. Elle délimite les rapports à examiner ensemble ; le verrouillage est une action distincte, après contrôle.

La vérification explique les dates manquantes, inversées ou déjà utilisées par un autre exercice. Le premier champ à corriger reçoit le focus. En présence d’un historique clôturé, le début doit se situer après sa dernière date verrouillée ; un bouton propose le lendemain lorsqu’il est compatible avec la fin saisie. Les exercices clôturés, ainsi que les exercices plus anciens déjà couverts par un verrouillage ultérieur, ne proposent plus la modification de leurs dates.

Un refus conserve la saisie et l’identifiant du même exercice. Les commandes sont bloquées pendant l’enregistrement. Si l’enregistrement réussit puis qu’une lecture échoue, **Actualiser les données** relit les exercices et les rapports sans renvoyer la création ou la modification. Cette reprise reste utilisable en lecture seule.

Le résultat propose **Voir mes exercices** et **Ouvrir le dossier**. L’exercice enregistré devient la période sélectionnée et ses dates sont appliquées aux rapports. Renommer ou ajuster un exercice ouvert conserve son identité et sa date de création.

## Préparer le dossier

Dans la liste, **Ouvrir le dossier** sélectionne les dates exactes de l’exercice. **Préparer le contrôle** vérifie les données comptables et les pièces liées. La préparation du contrôle et la clôture nécessitent un accès en modification.

Un contrôle signalant des opérations manquantes propose **Vérifier les comptes et les opérations manquantes**. Les déséquilibres proposent **Examiner le journal**. Une action permet ensuite de revenir au dossier ; un nouveau contrôle est requis après les corrections. Les problèmes d’intégrité ou de pièces restent visibles et ne sont pas considérés comme résolus par la navigation.

Un **dossier provisoire** peut être exporté pour examen avant la décision de clôture. Un contrôle utilisé pour un export doit être préparé à nouveau avant un autre export.

## Confirmer la clôture

**Clôturer définitivement** ouvre une fenêtre dédiée qui présente le nom de l’exercice, ses dates et l’effet du verrouillage. Il faut recopier son nom exact puis confirmer **Verrouiller l’exercice**.

Le verrouillage est cumulatif : il couvre toutes les dates jusqu’à la fin de l’exercice, y compris celles qui précèdent son début. Vérifiez donc aussi les opérations historiques avant de confirmer. Les données sources et les contrôles sont revérifiés par le moteur au moment de la décision.

Si les données ont changé, la confirmation conserve le nom saisi et explique le refus. **Refaire le contrôle** permet de préparer une nouvelle revue depuis cette fenêtre. La clôture n’est pas relancée automatiquement.

Après une clôture confirmée, une erreur d’actualisation propose uniquement de relire les états. Elle ne relance pas le verrouillage. Le dossier définitif peut ensuite être exporté. Un partage interrompu se reprend à partir du fichier déjà créé.

## Portée

Ces fonctions organisent et contrôlent le dossier produit par Zentra. Les pièces complémentaires, décisions d’approbation et obligations propres à l’entreprise restent à traiter selon sa situation. Ce guide décrit le comportement du moteur existant ; ce lot ne modifie ni les calculs fiscaux, ni le schéma, ni les règles de clôture.
