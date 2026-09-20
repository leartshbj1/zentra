# Utiliser Zentra Automation

## Pour une entreprise cliente

1. Installer la version disponible sur [Télécharger Zentra](https://zentraapp.ch/download) et connecter l’appareil au compte de l’entreprise. Les réglages intégrés et le bilan quotidien nécessitent la version 1.73.0.
2. Pendant la configuration, choisir **Découvrir et activer**, ou ouvrir **Zentra Automation** dans les paramètres. **Continuer sans cette option** permet de terminer la configuration sans achat.
3. Dans [Mon compte → Zentra Automation](https://zentraapp.ch/compte/automation), sélectionner l’entreprise. Seul son titulaire peut souscrire.
4. Lire les conditions, autoriser le traitement des extraits nécessaires, puis choisir **Activer · 15 CHF/mois**. Le paiement est confirmé sur Stripe. Ouvrir la page ne déclenche aucun paiement.
5. Après confirmation du paiement, activer les suggestions et choisir les fonctions voulues. Le mode **Observation** conserve les propositions invisibles pendant que l’utilisateur fait son choix. Le mode **Suggestions** affiche une proposition à vérifier.

Le compte doit disposer d’un abonnement Zentra Gestion actif. L’option et l’abonnement principal sont distincts. Le prix est de 15 CHF par mois et par entreprise. Le parrainage s’applique à Gestion, pas à cette option.

## Travailler en équipe avec la version 1.73.0

Une seule option suffit pour tous les collaborateurs de l’entreprise. Chacun se connecte à cette même entreprise dans Zentra Gestion ; les droits habituels restent appliqués. Le titulaire gère l’abonnement. Le titulaire et les administrateurs peuvent configurer les fonctions ; les autres collaborateurs consultent les réglages et utilisent les outils permis par leur rôle.

Dans **Paramètres → Zentra Automation**, choisir le mode et les fonctions, puis **Enregistrer pour toute l’équipe**. Les seuils se trouvent dans **Réglages avancés**. Les réglages sont partagés et actualisés en arrière-plan. Une modification distante détectée pendant une saisie demande de recharger les réglages avant de continuer.

Le tableau de bord affiche le bilan de la journée suisse pour toute l’entreprise : analyses terminées, suggestions préparées et choix validés par l’équipe. Une confirmation n’est pas un paiement ou une écriture automatique. Le détail sépare les analyses en observation et les choix à vérifier. Aucune statistique fictive de gain de temps n’est présentée. Les entreprises sans option ne voient pas ce bloc.

Sur les autres écrans, ouvrir la barre repliable **Zentra Automation** pour retrouver les outils adaptés au contexte. Sur mobile, les boutons reviennent à la ligne et les fonctions restent repliées par défaut. Les formulaires de gestion et leurs validations continuent de fonctionner comme auparavant.

## Ce qui change dans l’application

- **Banque** : proposition d’une catégorie autorisée et signalement d’une opération à examiner. L’utilisateur confirme ou corrige. Une suggestion ne crée ni écriture comptable ni paiement.
- **Documents** : le texte est extrait localement. Un court extrait sert à proposer le type de document et son écran de traitement. Le fichier original n’est pas supprimé ni déplacé par cette décision.
- **Achats** : proposition de fournisseur, projet et catégorie parmi ceux de l’entreprise connectée. Ces choix remplissent un brouillon modifiable, enregistré uniquement par l’action habituelle de validation.
- **Assistant** : le modèle local existant est conservé. Une action proposée ouvre un écran ou un formulaire autorisé après confirmation ; elle ne crée pas automatiquement une facture et ne la comptabilise pas.
- **Priorités** : les dates d’échéance sont calculées par le logiciel. Un signal du service ne peut pas abaisser la priorité imposée par une échéance dépassée.
- **E-mails** : classement des messages déjà importés dans le parcours d’achats. Aucun accès supplémentaire à une boîte mail et aucune réponse automatique.
- **Import CSV/Excel** : proposition des correspondances dans l’import du catalogue. Les colonnes restent modifiables et les lignes sont prévisualisées avant import. Ce n’est pas un outil général de migration de toutes les données d’un autre logiciel.

En cas de panne du service, les opérations habituelles restent disponibles et les choix peuvent être faits manuellement. Une confiance élevée permet une présélection, pas une validation financière automatique.

## Configuration fondateur

Se connecter avec le compte fondateur vérifié, puis ouvrir [les réglages en ligne](https://zentraapp.ch/compte/automation).

- **Clé API TypeSafe Jev** : saisir la clé obtenue dans le compte du fournisseur, puis **Vérifier et enregistrer**. La clé est chiffrée sur le serveur et n’est jamais demandée aux clients.
- **Vérifier le service** : contrôle réel avec une opération fictive, sans envoyer les données de l’entreprise.
- **Préparer le tarif de 15 CHF/mois** : contrôle ou préparation du tarif Stripe. Cette action ne souscrit pas d’abonnement et ne prélève rien.
- **Fonctions disponibles** : autoriser les fonctions globalement. Chaque entreprise doit ensuite disposer de l’option, donner son accord et activer ses fonctions.
- **Observation · 30 derniers jours** : volumes, délais, erreurs et comparaison entre proposition et choix réel. Les taux décrivent les décisions observées ; ils ne constituent pas une garantie de justesse comptable.

L’accès à l’administration fondateur est distinct de l’activation de l’option dans une entreprise. Le site et l’application lisent le même droit d’accès de l’entreprise.

## Parrainage

Dans le compte, afficher le code de son entreprise et le transmettre à une nouvelle entreprise cliente. Cette dernière saisit ce code lors de l’achat de Zentra Gestion.

- Nouvelle entreprise : **50 % sur sa première mensualité Gestion**.
- Entreprise qui parraine : **25 % sur une prochaine mensualité Gestion**, une fois le premier paiement de l’entreprise invitée confirmé.
- Plusieurs parrainages donnent des remises successives, sans cumul sur une même facture.
- Une remise déjà présente n’est pas remplacée. Les annulations, remboursements ou litiges éventuels nécessitent une vérification opérateur.

Les [conditions du parrainage](https://zentraapp.ch/parrainage/conditions) précisent l’éligibilité et le périmètre. Les essais techniques n’ont créé aucun paiement client ni récompense fictive.

## Exploitation et distribution

L’architecture, les fichiers, les variables serveur, les migrations et les contrôles sont détaillés dans [ZENTRA-AUTOMATION.md](ZENTRA-AUTOMATION.md). Les migrations D1 0047 à 0050 sont additives ; elles n’effacent pas les données. La base SQLite locale n’a pas de nouvelle migration pour cette version.

Les clients doivent installer la nouvelle version native pour voir les nouveaux écrans. La publication du site seule ne modifie pas une ancienne application installée. L’IPA est destiné à une signature personnelle via Sideloadly/AltStore ; le Mac n’est pas notarié par Apple et l’APK est une version de test ARM64. Les limites et preuves propres à chaque fichier sont consignées dans la note de version.
