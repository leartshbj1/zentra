# Notes — observations de l’équipe

Mode : Operate. Extension du workspace existant, documentée le 30 septembre 2026. Autorité visuelle : [DESIGN.md](../../DESIGN.md), monde « Précision calme ». Contraintes durables : [PRODUCT.md](../../PRODUCT.md). Ces fichiers, le sidecar et les autres contrats restent inchangés.

## Direction contract

THESIS : saisir et retrouver une observation dans l’entreprise ouverte, avec un enregistrement local compréhensible et un rattachement facultatif au projet.

OWN-WORLD : index et feuille opaques, typographie système, couleurs `work-*`, accent vert fonctionnel, séparateurs et boutons partagés. La surface reprend les règles existantes Functional Color, Familiar Type, Tonal Depth et Shared Sheet ; elle ne crée pas de nouvelle règle globale.

STORY : ouvrir Notes depuis Gestion ou un dossier projet, retrouver une note par recherche et filtre, écrire du texte ou des cases, épingler, lire l’état local, revenir à la liste. Les erreurs conservent le contenu et proposent Réessayer ou Garder une copie. Supprimer demande confirmation.

FIRST VIEWPORT : au bureau, index de notes avec recherche et filtre à gauche, feuille éditable à droite. Sur téléphone, liste puis éditeur dédié. En édition, les en-têtes et la navigation partagés se retirent ; la barre Retour–statut–actions et le pied Ajouter une case–Terminer restent accessibles. Sous 361 px, le statut passe sur une seconde ligne.

FORM : composants React et styles locaux, sans nouvel asset, palette ou mouvement propre à Notes. Les champs éditoriaux transparents, le titre de 28 px et le corps de 18 px sont particuliers à cette feuille. Ils ne redéfinissent pas les champs ordinaires du système.

FINISH : revue finale **ship** dans le périmètre Notes frontend examiné. Les [captures](../review/notes/) et [résultats navigateur](../review/notes/journey.json) sont des preuves de revue avec données fictives. Ce verdict ne certifie ni une release native ni une session réelle entre appareils.

## Expression implémentée

[NotesScreen](../../src/NotesScreen.tsx) et [notes.css](../../src/notes.css) définissent une grille avec un index de 260 à 340 px et une feuille flexible sur bureau. Sous 761 px, elle devient un parcours liste–éditeur. Les commandes utilisent les boutons existants et des icônes SVG. Sélection, caret et focus utilisent les rôles d’accent ; le statut est écrit et annoncé avec `role=status`. Les erreurs utilisent `role=alert`.

La hauteur de l’éditeur mobile suit `visualViewport`. La barre et le pied donnent priorité à `var(--safe-*, env(safe-area-inset-*))`. Les actions de pied mobile et les commandes iconographiques conservent au moins 44 px ; les lignes de cases ont aussi une hauteur de 44 px. La barre étroite réserve une ligne au statut pour préserver les commandes. Les contrôles restent désactivés en lecture seule.

## Vérité produit et périmètre

**Enregistrée** confirme l’écriture SQLite locale. Les brouillons de secours sont privés à l’espace local et leur persistance navigateur est facultative. La synchronisation utilise la collaboration d’entreprise existante ; cet écran n’ajoute ni présence en temps réel, ni comparaison de versions, ni service réseau Notes. La sauvegarde attendue et la suppression portent une version et un scope afin de refuser les écritures obsolètes ou destinées à un autre espace.

Une case est du texte dans la note, pas une tâche métier. L’auteur original reste conservé. Les textes d’interface passent par FR/DE/IT/EN ; le contenu saisi garde sa langue. La page publique `/gestion/notes` est une présentation publiée annonçant une prochaine mise à jour, distincte de la distribution native de l’application.

## Preuves et écarts

Les six parcours Edge comprennent 1440 px clair FR et sombre EN, 390 px clair FR/IT et sombre DE, et 320 px sombre FR. Les 12 captures montrent liste et éditeur ; `journey.json` consigne l’absence d’erreurs JavaScript et de débordement du document dans les états contrôlés. Les parcours français couvrent aussi création, retour pendant sauvegarde, suppression confirmée et écriture hors ligne avec pont fictif.

La validation du lot comprend 72 tests frontend, 5 contrôles SQLite et `build:web` réussis. Les tests Rust Notes ont compilé en mode `--no-run` mais leur exécution a été bloquée par Windows AppControl 4551. Aucune installation native, réception distante réelle ou session multiappareils n’est déduite de ces résultats. Le [relevé fonctionnel](../../../docs/FEATURE-NOTES.md) détaille les limites et les sources.

Aucun écart matériel avec le monde existant n’est retenu par la revue finale. La composition et les tailles éditoriales locales sont consignées ici sans les promouvoir en tokens globaux. Aucun défaut ou héritage d’autres écrans n’est réparé ou canonisé par ce lot documentaire.
