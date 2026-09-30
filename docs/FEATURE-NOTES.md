# Notes dans Zentra Gestion

État du lot : 30 septembre 2026. Notes est publié dans **Zentra 1.90.11** pour Windows, macOS, iPhone (IPA à signer) et Android (APK). Les builds, tests natifs et recettes de paquets sont consignés dans [RELEASE-1.90.11.md](RELEASE-1.90.11.md). La relecture Impeccable finale conclut **ship** pour la surface frontend examinée ; la synchronisation Notes entre appareils réels et les téléphones physiques restent non attestés.

## Fonction et accès

Notes conserve les observations de l’équipe dans l’entreprise ouverte. Une note contient un titre, du texte, un lien facultatif vers un projet, une épingle, l’auteur original et les dates de création et de modification. Les notes épinglées précèdent les autres ; chaque groupe est trié par modification récente.

- L’entrée **Notes** appartient au menu Gestion et aux destinations personnalisables. L’action **Écrire une note** peut être ajoutée aux raccourcis d’accueil.
- Le bouton **Notes** d’un dossier projet ouvre la liste filtrée pour ce projet et affiche son nombre de notes disponibles. Une nouvelle note reprend le projet du filtre courant ; elle peut ensuite être réaffectée ou laissée sans projet.
- La recherche porte sur le titre, le texte et le nom d’auteur, sans distinction de casse ni d’accents. Le filtre projet reste indépendant de la recherche.
- **Ajouter une case** insère une ligne `☐ ` au curseur. Les lignes `☐` et `☑` suivies de texte alimentent une liste à cocher repliable ; cocher une ligne modifie le même texte, sans créer de tâche Agenda ou Projet.
- La suppression demande confirmation pour toute l’équipe. **Garder une copie**, proposé après une erreur d’enregistrement, crée une nouvelle note avec le contenu local et un nouvel identifiant.

L’interface est disponible en français, allemand, italien et anglais. Les titres, textes, auteurs et noms de projets saisis par les personnes conservent leur langue. Le titre de liste utilise la première ligne non vide du texte si le titre est vide. Fermer un nouvel éditeur entièrement vide ne crée pas d’enregistrement d’entreprise.

## Enregistrement local et reprise

Le store d’écriture vit dans `WorkspaceApp`, au-dessus de l’éditeur : changer d’écran ne détruit pas une sauvegarde en cours. Il programme un enregistrement après 650 ms sans nouvelle modification, sérialise les écritures d’une même note et conserve les changements saisis pendant une écriture. Retour, changement de note et sortie de l’éditeur demandent aussi une sauvegarde immédiate.

Le pont appelle `save_work_note`. La commande valide l’espace, les droits et les données, écrit la note et son audit dans une transaction SQLite, puis renvoie l’enregistrement local. Elle ne dépend pas d’une requête réseau. **Enregistrée** signifie que cette écriture locale a réussi ; ce statut ne confirme pas une réception par un autre appareil. **Modifications en cours**, **Enregistrement…** et **À enregistrer** décrivent les autres états locaux.

Les brouillons non enregistrés et leur version de référence sont également conservés dans `localStorage`, sous `zentra.notes.drafts.<scope>`, pour permettre une reprise. Cette copie est un mécanisme de secours : le stockage navigateur peut être indisponible ou effacé et SQLite reste la persistance principale. Une fermeture forcée avant la fin de l’enregistrement n’est pas couverte par une garantie de durabilité absolue. L’indication hors ligne repose sur l’état réseau du navigateur ; elle ne remplace pas le statut d’enregistrement.

Le `scope` est privé à l’espace local. Il est conservé lors d’une réception ordinaire de la même entreprise et renouvelé lors d’un import, d’une réinitialisation ou d’une première jonction à un autre espace. Le pont transmet le scope attendu ; le natif refuse une écriture retardée si l’entreprise ouverte a changé. Les anciens brouillons restent sous leur ancienne clé et ne sont pas appliqués silencieusement à la nouvelle entreprise.

## Synchronisation et conflits

La migration SQLite **61** ajoute `work_notes` aux tables métier partagées et au suivi transactionnel existant. Les notes enregistrées suivent l’horloge, les archives et la fusion à trois versions de la collaboration d’entreprise. Aucun service de synchronisation propre à Notes n’est introduit. L’export CSV les place dans `07_projets/notes.csv` ; les sauvegardes emportent aussi les suppressions. Le scope des brouillons est retiré des copies partagées et n’est pas une identité d’entreprise envoyée aux collègues.

Chaque modification ou suppression transmet `expectedUpdatedAt`, la version lue avant l’édition. Une version devenue obsolète est refusée au lieu d’écraser la note. L’horodatage avance strictement, même si l’horloge de l’appareil recule. La création utilise un UUID stable afin qu’une reprise identique ne crée pas de doublon. Le store ne remplace pas un texte local en cours d’édition lors d’une réception de données ; une note déjà enregistrée peut être actualisée depuis les données reçues.

Après un échec, le texte reste dans l’éditeur et le brouillon local. **Réessayer** utilise encore la version de référence ; un vrai conflit nécessite donc de conserver une copie ou de recharger la version courante avant de poursuivre. Cet écran ne présente pas de comparaison ligne par ligne ni d’édition simultanée en temps réel. La résolution des conflits entre archives reste celle de la collaboration existante.

La suppression conserve une ligne avec `deleted_at`, masquée dans la liste. Ce témoin empêche de recréer une note supprimée sous le même UUID depuis une ancienne copie. Une suppression concurrente à une modification doit être traitée comme un conflit. Supprimer un projet conserve ses notes avec un lien projet nul. L’auteur original et la date de création restent immuables.

## Droits et périmètre

Le mode lecture seule désactive création, édition, épingle, cases, copie et suppression dans l’interface. Les commandes natives appliquent aussi le contrôle d’écriture existant et le rôle local `read_only`. L’existence du projet et les identifiants sont contrôlés côté natif.

L’éditeur limite le titre à 200 caractères et le texte à 50 000 caractères ; le modèle natif et la contrainte SQLite acceptent jusqu’à 100 000 caractères de texte. Ces limites différentes sont conservées telles qu’implémentées. Notes reste du texte simple : pas de pièces jointes propres aux notes, de mise en forme riche, de partage public, de rappel, de conversion automatique en document commercial ni d’action Automation déclenchée par son contenu.

## Continuité du design

La surface étend le système [Précision calme](../desktop/DESIGN.md) et les contraintes de [PRODUCT.md](../desktop/PRODUCT.md), sans changement d’identité. Elle réutilise les couleurs `work-*`, la typographie système, les boutons partagés, le focus d’accent et les statuts écrits. La feuille et l’index restent opaques, avec des séparateurs et une sélection tonale.

Sur bureau, la liste et l’éditeur sont côte à côte. Sous 761 px, la liste et l’éditeur se succèdent ; pendant l’édition, le chrome partagé se retire pour laisser la feuille et ses commandes. La hauteur suit `visualViewport` lorsqu’il est disponible. Barre et pied respectent les variables natives `--safe-*`, avec `env(safe-area-inset-*)` en repli. Le pied mobile garde des actions d’au moins 44 px. Sous 361 px, le statut d’enregistrement occupe sa propre ligne sous Retour, Épingler et Supprimer.

Les champs éditoriaux transparents, le titre de 28 px et le corps de 18 px sont des choix locaux de cet éditeur ; ils ne remplacent pas les primitives de champ générales. Aucun écart matériel avec le monde visuel courant n’a été retenu par la revue finale. [Le contrat Notes](../desktop/.impeccable/surfaces/notes.md) consigne cette composition. `DESIGN.md`, son sidecar et les autres contrats existants restent inchangés.

## Preuves et limites de validation

Le lot a passé les validations suivantes :

| Validation | Résultat et portée |
| --- | --- |
| Tests frontend ciblés | **74 réussis** : 48 `workNotes`, 10 bridge, 8 préférences, 6 navigation native et 2 historique des versions. Suite complète : **1 905 réussis, 1 ignoré**. Ils vérifient les stores et contrats frontend, sans prouver une exécution native sur téléphone physique. |
| Contrôles SQLite portables | **5 réussis** : migration et intégrité, contraintes, auteur immuable, suppression et retrait de projet, sauvegarde et réouverture. Bases temporaires, sans accès à un profil utilisateur réel. |
| Tests Rust | **10 tests Notes réussis** sur Windows (CircleCI 199) et Mac (200), dont migration 60 → 61, CRUD, droits, scopes, audit et conflits. Les groupes Company passent aussi : **40 réussis, 1 diagnostic ignoré** sur chaque plateforme. |
| Compilation interface | `build:web` réussi pour TypeScript et Vite. Ce résultat ne produit pas à lui seul un paquet natif distribué. |
| Parcours navigateur | **6 configurations Edge réussies**, consignées dans [journey.json](../desktop/.impeccable/review/notes/journey.json), avec [12 captures liste/éditeur](../desktop/.impeccable/review/notes/). Données et pont natif fictifs. |
| Relecture Impeccable finale | **ship** pour Notes dans le périmètre frontend examiné : statut sur sa ligne à 320 px, safe areas natives prioritaires, pied tactile de 44 px. |

Les configurations navigateur sont 1440 px clair FR, 390 px clair FR, 320 px sombre FR, 390 px sombre DE, 390 px clair IT et 1440 px sombre EN. Le script vérifie édition et cases, sauvegarde simulée, absence d’erreur JavaScript et de débordement horizontal du document ; les parcours français ajoutent création, retour avant la fin de sauvegarde, suppression confirmée et édition hors ligne avec le pont fictif. Cela ne prouve pas tous les états de conflit, toutes les dimensions, une utilisation avec clavier natif ou une synchronisation réelle entre appareils.

La page de présentation distincte [zentraapp.ch/gestion/notes](https://zentraapp.ch/gestion/notes), initialement publiée dans Sites **303** puis reprise sans captures d’application dans **304**, annonce désormais la disponibilité dans **1.90.11**. Le site **305**, source `f2ae8d88`, est déployé avec succès ; ses téléchargements et manifestes updater proviennent des paquets publiés vérifiés. Cette publication a passé les tests locaux et le build du site ; aucun contrôle navigateur du site public n’a été ajouté à cette livraison.

La release native est attestée : quatre installables publics, signatures de mise à jour Windows/Mac vérifiées, APK à identité persistante, IPA non signée. Les recettes Windows/Mac couvrent le démarrage et redémarrage sur des profils isolés ; Android couvre l’émulateur, thèmes et clavier. Restent non attestés : parcours Notes interactif dans ces paquets, session réelle de plusieurs appareils, réception distante des notes et comportement sur téléphone physique. Aucun résultat navigateur ni verdict de design ne constitue une validation sur appareil iOS physique.

## Sources d’implémentation

[NotesScreen.tsx](../desktop/src/NotesScreen.tsx), [notes.css](../desktop/src/notes.css), [workNotes.ts](../desktop/src/workNotes.ts), [WorkspaceApp.tsx](../desktop/src/WorkspaceApp.tsx), [bridge.ts](../desktop/src/bridge.ts), [ProjectFolder.tsx](../desktop/src/ProjectFolder.tsx), [traductions](../desktop/src/translationsNotes.ts), [commandes et stockage natifs](../desktop/src-tauri/src/work_notes.rs), [migration](../desktop/src-tauri/src/work_notes_schema.sql), [collaboration](../desktop/src-tauri/src/company_collaboration.rs), [fusion](../desktop/src-tauri/src/company_merge.rs), [sauvegardes](../desktop/src-tauri/src/backup.rs), [tests Rust](../desktop/src-tauri/src/work_notes_tests.rs), [contrôles SQLite](../desktop/scripts/test-work-notes-schema.py) et [parcours navigateur](../desktop/tests/notes-journey.mjs).
