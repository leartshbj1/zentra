# Messagerie partagée — réglages et envoi

Mode : Operate. Extension de la surface workspace, monde existant « précision calme ». DESIGN.md et PRODUCT.md restent inchangés.

## Direction contract

THESIS : une adresse vérifiée pour l’entreprise, un message relu par la personne qui l’envoie, un résultat compréhensible même si la connexion est interrompue.

OWN-WORLD : feuilles opaques, typographie système, séparateurs fins et accent vert du système. Aucune nouvelle palette ou animation. Les champs et boutons existants sont conservés.

STORY : choisir la portée de connexion dans les réglages, vérifier l’identité d’expédition, préparer un document, lire son état. L’adresse partagée Infomaniak et le SMTP propre à un appareil sont des choix explicites. La lecture Support reste indépendante de l’autorisation d’envoi.

FIRST VIEWPORT : réglages limités à deux choix de portée et la connexion correspondante. Dans le compositeur, un sélecteur compact précède l’expéditeur et les trois champs du message. Sur téléphone, disposition verticale et contrôles d’au moins 44 px ; détails d’historique repliés.

FORM : extension fonctionnelle des réglages existants. Pas de comp générée. Aucun changement aux modèles saisis par l’utilisateur ni aux documents PDF.

FINISH : unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Contraintes

La connexion partagée est liée à l’entreprise et aux droits serveur. Jamais de réutilisation silencieuse du secret Support, de renvoi automatique ou de remplacement par SMTP après un échec partagé. « Accepté » ne signifie pas reçu. La déconnexion de l’entreprise demande confirmation dans l’interface. Les textes d’interface existent en FR/DE/IT/EN ; le contenu du client reste intact.

## Preuves et limites

Les captures dans `../review/shared-mail/` viennent des composants réels avec des données et un pont natif fictifs : Edge et WebKit, 390 px sombre et 1440 px clair ; réglages allemands, italiens et anglais à 390 px. `results.json` trace connexion, envoi unique, reprise sans renvoi, récupération après réouverture, lecture seule, choix SMTP explicite et débordement.

Ces aperçus ne prouvent pas une installation iOS/macOS ou un envoi réel. La nouvelle suite Rust compile ; son exécution locale est refusée par le contrôle d’applications Windows (4551). Les migrations serveur et les clients sont encore non publiés.
