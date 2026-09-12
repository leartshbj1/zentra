# Retrouver une création interrompue

Lors de l’ajout d’un client, d’un fournisseur, d’un collaborateur, d’un article du catalogue, d’une saisie de temps ou d’une dépense, une réponse interrompue ne signifie pas forcément que la création a échoué.

Zentra recherche l’élément dans la base à partir de l’identifiant préparé pour cette tentative. S’il est retrouvé, la fiche apparaît et vous pouvez continuer. La création n’est pas envoyée à nouveau.

Si la base ne répond pas, la fenêtre **Vérifier l’enregistrement** explique la situation. Utilisez **Vérifier maintenant** : cette action relit les données. Les modifications restent momentanément suspendues pour éviter une deuxième création. Cette vérification fonctionne aussi si votre accès est passé en lecture seule entre-temps.

Si la vérification confirme que rien n’a été créé, le formulaire conserve votre saisie et indique le problème. Vous pouvez corriger les informations signalées, puis enregistrer. Une nouvelle tentative n’est autorisée qu’après cette vérification.

La fenêtre **Enregistrement effectué** a un sens différent : la base a déjà confirmé la sauvegarde et seule l’actualisation de l’écran manque. **Actualiser les données** relit alors cette sauvegarde.

Cette reprise concerne l’opération en cours dans l’application ouverte. Elle ne restaure pas un formulaire après fermeture forcée ou redémarrage. Les parcours particuliers de paiement, de facture, de projet et de fiche de salaire conservent leurs propres contrôles.
