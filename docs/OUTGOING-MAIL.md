# Envoyer les documents par e-mail

Relevé du 26 septembre 2026. Fonctionnalité en préparation pour Zentra Gestion 1.89.0 ; aucune publication ni transmission à une vraie boîte mail n’est établie par ce guide.

Zentra prépare un e-mail depuis un devis, une facture ou une relance. Vous vérifiez le destinataire, l’objet et le message, puis déclenchez l’envoi. Le PDF du document est joint automatiquement ; pour une relance, il s’agit du PDF de la facture concernée. Aucun envoi automatique ni renvoi en arrière-plan n’est prévu.

## Connecter la messagerie

1. Dans l’entreprise concernée, ouvrez **Paramètres → E-mails → Messagerie**. La configuration demande les droits du propriétaire ou d’un administrateur et un accès en écriture.
2. Choisissez **Infomaniak** ou **Autre messagerie · SMTP**. Le préréglage Infomaniak fourni par l’application est `mail.infomaniak.com`, TLS, port 465. Pour un autre fournisseur, renseignez son serveur et choisissez TLS ou STARTTLS ; le port reste modifiable.
3. Renseignez le nom et l’adresse d’envoi, l’identifiant SMTP et le mot de passe de la boîte. Utilisez un mot de passe d’application si votre fournisseur le demande. Les comptes qui exigent uniquement OAuth ne sont pas pris en charge par cette connexion SMTP avec mot de passe.
4. Cliquez sur **Connecter ma messagerie**. Zentra vérifie la connexion avant de l’enregistrer. Cette vérification n’envoie aucun e-mail de test.

La connexion appartient à cette entreprise sur cet appareil. Ses identifiants restent protégés dans le coffre de l’appareil ; ils ne suivent ni la synchronisation de l’entreprise ni sa sauvegarde métier. Connectez donc la messagerie sur chaque appareil. **Déconnecter** retire la connexion locale.

Après connexion, un mot de passe laissé vide conserve celui qui est enregistré. Un changement de serveur, port, chiffrement ou identifiant demande de le saisir à nouveau. L’état « Connectée sur cet appareil » indique qu’une configuration a été enregistrée ; il ne garantit pas qu’une connexion future réussira.

## Personnaliser les modèles

Dans **Paramètres → E-mails**, les onglets **Devis** et **Factures** règlent séparément l’objet et le message. Les modèles sont enregistrés dans les paramètres de l’entreprise et suivent ses données partagées. Les textes des relances restent dans **Relances → Cycle & textes**.

Placez le curseur dans l’objet ou le message, puis choisissez une variable. Le clic l’insère sans enregistrer le modèle. Cliquez ensuite sur **Enregistrer les modèles**. La confirmation d’enregistrement disparaît lorsque vous modifiez à nouveau le texte.

| Variable | Valeur préparée pour le document |
| --- | --- |
| `{entreprise}` | Nom de l’entreprise |
| `{client}` | Société du client, ou son nom si la société est vide |
| `{numero}` | Numéro du devis ou de la facture |
| `{montant}` | Montant total, avec devise |
| `{solde}` | Solde calculé du document |
| `{echeance}` | Fin de validité du devis ou échéance de la facture |
| `{date}` | Date d’émission |
| `{email_entreprise}` | E-mail renseigné dans le profil de l’entreprise |
| `{telephone}` | Téléphone renseigné dans le profil de l’entreprise |

L’objet doit tenir sur une ligne, avec au plus 250 caractères. L’objet et le message sont obligatoires. Les variables inconnues sont refusées. L’e-mail du profil d’entreprise utilisé par `{email_entreprise}` peut être différent de l’adresse SMTP configurée : vérifiez le texte préparé.

## Envoyer un document

1. Émettez le devis ou la facture : un brouillon sans numéro ou un document annulé ne peut pas être envoyé. Pour une relance, ouvrez sa préparation dans **Relances**.
2. Cliquez sur **Envoyer par e-mail** depuis le document ou son aperçu. Si nécessaire, connectez la messagerie depuis la fenêtre, puis revenez au message.
3. Vérifiez l’expéditeur, l’adresse **À**, l’objet, le message et le nom du PDF joint. Vous pouvez modifier ces trois champs pour cet envoi sans changer les modèles. Si le client n’a pas d’adresse, saisissez-la pour cet envoi.
4. Cliquez sur **Envoyer l’e-mail**. **Annuler** ferme la préparation sans envoi. Une tentative commencée verrouille les champs et empêche une seconde soumission depuis la même fenêtre.

Si le document, son solde, le client ou l’entreprise a changé depuis la préparation, Zentra demande de fermer puis de rouvrir le message pour reprendre des données à jour. Les relances conservent leurs contrôles métier avant transmission.

## Comprendre le résultat

- **E-mail transmis / accepté par le serveur** : le serveur SMTP a accepté l’e-mail. Cela ne confirme ni sa livraison, ni sa lecture, ni sa présence dans la boîte de réception du destinataire.
- **Refusé par le serveur** : vérifiez le destinataire, l’expéditeur autorisé et la connexion avant une nouvelle préparation.
- **Envoi non confirmé** ou connexion interrompue : le message a peut-être été accepté. Vérifiez auprès du destinataire ou du fournisseur avant de fermer puis rouvrir une nouvelle préparation. Zentra ne réessaie pas automatiquement.
- **Historique local incomplet après acceptation** : ne renvoyez pas le message pour cette seule raison ; le serveur l’a déjà accepté.

La fenêtre peut afficher les cinq dernières tentatives de ce document sur cet appareil. L’acceptation est également destinée à l’audit métier ; une relance échue est terminée après acceptation SMTP, sans que ce statut prouve sa réception. Zentra ne dépose pas de copie dans le dossier **Envoyés** du fournisseur.

## Périmètre et preuves

Ce flux utilise les commandes natives de Gestion. Son aperçu navigateur est une fixture avec entreprise, adresses et transport fictifs. La nouvelle interface est actuellement en français ; elle ne constitue pas une traduction complète de cette fonctionnalité dans les autres langues de Gestion.

Les [résultats du parcours navigateur](../.impeccable/review/outgoing-mail/results.json) couvrent quatre combinaisons : Edge et WebKit, chacune à 390 px en sombre et 1440 px en clair. Ils vérifient les réglages, les modèles, la composition, un passage clavier, la soumission unique, l’absence de renvoi après résultat incertain, l’annulation sans envoi, l’insertion sans enregistrement et l’effacement de la confirmation après modification. Aucun débordement horizontal ni erreur JavaScript n’y est enregistré.

Le handoff de build annonce 1 673 tests frontend réussis et un `cargo check` réussi. Les tests natifs utilisent un transport simulé avec génération réelle du PDF ; le résultat final des tests natifs cloud n’était pas acquis dans ce relevé, une fixture de paiement datée étant en correction. Aucune de ces preuves ne vaut essai SMTP réel, livraison au destinataire, validation sur appareil mobile physique ou publication. La [comparaison avec le système visuel](../.impeccable/review/outgoing-mail/documentation.md) détaille les captures et le verdict de correction.

Sources : [interface](../desktop/src/OutgoingMailPanel.tsx), [points d’entrée](../desktop/src/OutgoingMailEntry.tsx), [variables et commandes](../desktop/src/outgoingMail.ts), [transport natif](../desktop/src-tauri/src/outgoing_mail.rs), [tests natifs](../desktop/src-tauri/src/outgoing_mail_tests.rs).
