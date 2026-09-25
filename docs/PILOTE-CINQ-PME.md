# Pilote Zentra — cinq PME

Statut : protocole prêt ; aucun participant ni résultat réel encore enregistré.

## Organisation

Prévoir cinq entreprises volontaires, une séance de 35 minutes par entreprise et deux appareils connectés au même espace. Utiliser une entreprise de recette et des documents fictifs, clairement marqués TEST. Ne rien envoyer à un client réel et ne pas comptabiliser un test dans une entreprise de production. Obtenir l’accord des participants avant toute capture ; ne collecter que les mesures nécessaires.

Le participant réalise les tâches sans intervention. L’observateur note l’écran du blocage, les mots exacts de l’erreur et toute aide apportée. Une tâche terminée avec aide ne compte pas comme une réussite autonome. Mesurer séparément le temps d’attente réseau et le temps de compréhension.

## Scénarios communs

| ID | Consigne au participant | Preuve de réussite |
| --- | --- | --- |
| A | Se connecter sur le deuxième appareil et retrouver l’entreprise créée sur le premier. | Même identifiant d’espace ; mêmes clients, logo et documents ; pas d’entreprise vide créée automatiquement. |
| B | Préparer un devis fictif, le convertir en facture puis enregistrer un paiement. | L’autre appareil affiche automatiquement le document et le même reste à recevoir. Mesurer le délai après chaque enregistrement, sans cliquer sur Synchroniser. |
| C | Couper le réseau d’un appareil, modifier une note, puis rétablir le réseau. | Statut hors ligne, note conservée, réception sur l’autre appareil après reconnexion. Modifier aussi une même note simultanément : aucune perte silencieuse. |
| D | Recevoir trois factures fournisseurs fictives et une confirmation de rendez-vous dans la messagerie de recette. | Relever classement, fournisseur sélectionné/créé, référence, montants, dates, document source et événement de l’agenda ; les doublons ne créent pas de deuxième écriture. Une ambiguïté reste à vérifier. |
| E | Créer une fiche de salaire fictive avec une assurance manquante, suivre la correction puis reprendre. | Le bon réglage s’ouvre, le salaire et le collaborateur restent conservés, la vérification ne boucle pas, une seule fiche est créée. Vérifier ensuite les montants indépendamment. |
| F | Choisir quatre raccourcis mobiles et quatre actions d’accueil ; fermer et rouvrir l’app. | Choix et ordre conservés ; Menu accessible ; les préférences de l’autre utilisateur n’ont pas changé. |

## Mesures et décision

Utiliser `pilot-results.csv` : une ligne par tâche, entreprise et tentative. Le résultat est « autonome », « avec aide », « échec » ou « non testé ». Noter les secondes, le nombre d’erreurs, d’actions mal comprises et de décisions Automation corrigées. Un test manquant reste manquant.

Priorité absolue : aucune perte de document, aucun paiement dupliqué, aucune fuite entre entreprises. Bloquer la publication d’une version présentant l’un de ces défauts. Pour l’ergonomie, regrouper les obstacles observés chez plusieurs participants et corriger d’abord ceux qui empêchent une tâche. Comparer les délais de synchronisation aux trois secondes attendues en connexion normale ; conserver le contexte réseau lorsqu’ils sont plus longs.

Les économies de temps ne seront présentées commercialement qu’après comparaison de tâches équivalentes avec et sans Automation. Les tests automatisés et les données fictives du développeur ne constituent pas ce pilote.

## Avant de commencer

- Renseigner les cinq participants et leur accord ; ne pas envoyer d’invitations sans destinataires autorisés.
- Noter la version installée sur chaque appareil et les produits actifs dans l’espace.
- Vérifier que la synchronisation réelle fonctionne sur cet espace de recette avant la séance.
- Garder les mots de passe et les clés API hors du fichier de résultats.
