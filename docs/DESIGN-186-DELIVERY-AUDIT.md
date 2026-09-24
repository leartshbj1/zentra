# Refonte 1.86 — état de livraison vérifié le 24 septembre 2026

L’objectif complet reste la refonte du site, de Gestion et de Support, avec la palette Zentra, une hiérarchie plus simple et des interfaces adaptées au téléphone. La préparation d’un exécutable Windows ne remplace pas cet objectif.

| Exigence | Évidence actuelle | État |
| --- | --- | --- |
| Présentation du site et des produits | Source `cdb1bb456ea0e9abee0eca654f7a366d59a832ae`, Sites 252 ; déploiement `appgdep_6ab52d47535881919c88ad1650630d5a` relu, état `succeeded` ; site public actif sur `https://www.zentraapp.ch` | Publié |
| Revue visuelle du site et Support | `outputs/studio-site-fix2-verdict.md` du checkout site : quatre corrections notées résolues, 19 captures et états interactifs fournis | Corrections du lot acceptées ; pas de certification de toutes les fonctions backend |
| Nouveau système visuel Gestion | CSS, composants et version 1.86 figés dans `e5768bf07c5b9a93f533559319f12e291904a5a6` ; palette verte, clair/sombre, navigation et journal Automation conservés dans les tokens documentés | Implémenté |
| Revue Gestion bureau/téléphone | `outputs/redesign186/native-fix2-verdict.md` : 22 captures du lot ; compositions Comptabilité/Achats et actions Ventes résolues ; Agenda desktop partiel | Non terminé : deux boutons se coupent en milieu de mot |
| Documentation du système | `desktop/DESIGN.md`, `desktop/.impeccable/design.json` v2, huit spécimens ; commit documentaire `f398bce3` | Terminé à la portée documentée |
| Régressions frontend | 1 646 tests / 202 fichiers, TypeScript et compilation de production réussis | Validé dans le banc d’essai ; ne prouve pas les installations mobiles |
| Paquet Windows | NSIS 1.86 construit depuis la source candidate ; signature de mise à jour vérifiée cryptographiquement avec la clé publique distribuée | Construit, non publié |
| Contenu du NSIS | Exécutable extrait et comparé octet par octet au build avec son marqueur NSIS ; WebView2Loader présent ; lancement et réouverture dans un profil fictif, schéma 60, intégrité et clés étrangères valides | Validé pour le contenu et le démarrage ; l’installateur n’a pas été exécuté |
| Version installée chez l’utilisateur | Aucun remplacement de son installation ni accès à ses données pendant ces essais | Non livré |
| Canaux publics Windows et Mac | Manifestes publics relus : tous deux en 1.85.1 | 1.86 non publiée |
| Paquets Mac, iPhone et Android 1.86 | Aucun job de compilation 1.86 lancé ni paquet correspondant vérifié | Manquant |

Preuves du paquet : `outputs/release186/windows-candidate/candidate-manifest.json`, `outputs/release186/local-smoke/verification.json`, `outputs/release186/extracted-package-smoke/verification.json`. L’extraction locale n’installe pas le paquet dans Windows et n’écrit pas son registre. L’outil d’extraction portable provient de la distribution officielle 7-Zip 26.03 ; ses deux téléchargements ont été comparés aux SHA-256 publiés par le dépôt officiel.

## Conditions restantes

- Le deuxième verdict natif conserve uniquement la coupure des boutons « Aujourd’hui » et « Ajouter » à 1 440 px. Une question est déjà ouverte pour choisir une dernière correction ciblée ou la diffusion en l’état. Aucune réponse n’a été reçue. Aucun troisième passage visuel ni nouvelle recherche de défauts n’a été lancé.
- L’accès à l’interface du service de compilation échoue encore avant l’initialisation du navigateur : `failed to write kernel assets: Le chemin d’accès spécifié est introuvable. (os error 3)`. La tentative de lecture des surfaces de ce tour confirme ce blocage. Aucun accès de compte, mot de passe ni clé n’a été recherché dans les fichiers du navigateur pour le contourner.
- Après le choix visuel, la source définitive devra être figée, les paquets des plateformes compilés et testés, puis les canaux publiés. Une capture du navigateur ne sera pas présentée comme un essai sur iPhone ou Mac physique.

La même attente de décision et l’indisponibilité de l’accès de compilation ont persisté pendant les trois derniers tours du but. Les préparations indépendantes ont progressé jusqu’au paquet Windows et à sa vérification ; elles sont désormais terminées. La refonte complète n’est pas déclarée achevée.
