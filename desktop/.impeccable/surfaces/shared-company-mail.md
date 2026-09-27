# Messagerie partagée — réglages et envoi

Mode : Operate. Extension fonctionnelle de la surface workspace dans le monde existant « précision calme », documentée le 27 septembre 2026. [DESIGN.md](../../DESIGN.md), [PRODUCT.md](../../PRODUCT.md) et le sidecar [design.json](../design.json) restent inchangés ; ce lot n'établit aucun nouveau système visuel.

## Direction contract

THESIS : une adresse vérifiée pour l’entreprise, un message relu par la personne qui l’envoie, un résultat compréhensible même si la connexion est interrompue.

OWN-WORLD : feuilles opaques, typographie système, séparateurs fins et accent vert du système. Aucune nouvelle palette ou animation. Les champs et boutons existants sont conservés.

STORY : choisir la portée de connexion dans les réglages, vérifier l’identité d’expédition, préparer un document, lire son état. L’adresse partagée Infomaniak et le SMTP propre à un appareil sont des choix explicites. La lecture Support reste indépendante de l’autorisation d’envoi.

FIRST VIEWPORT : réglages limités à deux choix de portée et la connexion correspondante. Dans le compositeur, un sélecteur compact précède l’expéditeur et les trois champs du message. À la réouverture, tout précédent envoi en attente ou incertain présent dans l'historique chargé apparaît avant les champs, avec date, destinataire, statut et action disponible. Ce bloc reste visible quand les détails d'historique sont repliés. Sur téléphone, disposition verticale et contrôles d’au moins 44 px.

FORM : extension fonctionnelle des réglages existants. Pas de comp générée. Aucun changement aux modèles saisis par l’utilisateur ni aux documents PDF.

FINISH : relecture terminée pour le correctif P1, disposition `ship` limitée aux éléments examinés ; voir le [verdict indépendant](../review/shared-mail/finish-review.md) et le [relevé documentaire](../review/shared-mail/documentation.md). Le contrat visuel existant est préservé. Aucun nouveau raster produit n'est livré ; les captures sont des preuves de revue.

## Contraintes

La connexion partagée est liée à l’entreprise et aux droits serveur. Jamais de réutilisation silencieuse du secret Support, de renvoi automatique ou de remplacement par SMTP après un échec partagé. « Accepté » ne signifie pas reçu. La déconnexion de l’entreprise demande confirmation dans l’interface. Les textes d’interface existent en FR/DE/IT/EN ; le contenu du client reste intact.

Un précédent envoi non confirmé bloque une nouvelle soumission jusqu'à résolution de son état ou reconnaissance explicite par la personne qu'elle a vérifié les messages envoyés. Cette reconnaissance ne transmet aucun message et ne change pas l'état de la tentative antérieure. La récupération d'une ancienne tentative n'affiche pas le succès du nouveau brouillon. Une tentative déjà soumise dans le compositeur courant ne peut pas être renvoyée depuis ce même compositeur.

## Expression implémentée

Les [réglages](../../src/MailSettings.tsx) conservent les rubriques Messagerie, Devis et Factures. [SharedMailSettings](../../src/SharedMailSettings.tsx) ajoute les choix « Pour l’entreprise » / « Sur cet appareil », la connexion partagée, son identité vérifiée et sa confirmation de déconnexion. Le [compositeur](../../src/MailComposer.tsx) expose la portée choisie, l'expéditeur, les états d'envoi et la récupération. Le [dictionnaire](../../src/translationsOutgoingMail.ts) traduit l'interface, pas le message saisi.

La [feuille de style locale](../../src/outgoing-mail.css) réutilise les rôles `work-*`, les boutons, champs et dialogues existants. Les réglages sont centrés dans une largeur maximale de 760 px. Le groupe de portée utilise deux options qui se réorganisent selon leur contenu ; le compositeur utilise un sélecteur compact. Les champs passent d'une ou deux colonnes selon leur contexte à une seule sous 600 px. Les séparateurs regroupent connexion, pièce jointe, récupération et historique ; aucun mouvement propre au lot n'est ajouté. Ces compositions restent des décisions de cette surface, pas de nouveaux tokens globaux.

## Preuves et limites

Les captures dans [le dossier de revue](../review/shared-mail/) viennent des composants réels avec des données et un pont natif fictifs : Edge et WebKit, 390 px sombre et 1440 px clair ; réglages allemands, italiens et anglais à 390 px clair sur Edge. [results.json](../review/shared-mail/results.json) rapporte connexion, déconnexion confirmée, envoi unique, reprise sans renvoi, récupération après réouverture, reconnaissance manuelle sans envoi, lecture seule et choix SMTP explicite. Les assertions de débordement portent sur l'état de lecture seule du compositeur et les trois réglages traduits ; elles ne constituent pas une couverture exhaustive de toutes les vues.

Le P1 initial masquait l'envoi non confirmé dans l'historique replié après réouverture. Le verdict indépendant conclut ce P1 résolu et `ship` pour la correction examinée, sans approbation de l'application entière.

Ces aperçus ne prouvent pas une installation iOS/macOS, une validation sur appareil physique ou un envoi réel. Le [journal de compilation Vite finale](../../../outputs/company-mail-web-build-final.log) confirme une compilation réussie après la correction, avec l'avertissement de taille de chunk Excel existant. L'exécution locale des tests natifs a été refusée par le contrôle d'applications Windows (4551). La [CI 141](../../../outputs/company-mail-windows-141.json), source `e862214ee73e20b2b5dc546ddf21adc5b7262dab`, a réussi le 27 septembre à 15:24 Europe/Zurich : 18 tests e-mails, dont les quatre nouveaux scénarios partagés, sont passés. Elle ne publie aucun installateur. L'extension existe dans les sources ; elle n'est pas attribuée aux paquets déjà livrés de la version 1.90.4. Aucune migration serveur ni publication de cette extension n'est établie par ce dossier.
