# Personnalisation des documents — 27 septembre 2026

Lot postérieur au gel de **1.90.5**, non inclus dans les paquets publics. Il complète la traduction des outils avancés du studio de documents et corrige deux défauts visibles. Il ne clôt pas les vingt points de l’audit.

## Comportements

- Les réglages de police, couleur, mise en page, mesures précises, modèles et texte riche sont disponibles en FR/DE/IT/EN. Les noms de modèles saisis, textes du client, montants et valeurs des réglages sont conservés. Les ancrages des outils sont indépendants des libellés traduits.
- Les erreurs de validation locales sélectionnent le passage concerné. Une erreur PDF native sans traduction connue reçoit une indication localisée et conserve son détail original dans un volet replié ; sa destination de correction reste calculée à partir du motif original. Les autres erreurs natives inconnues ne sont pas déclarées intégralement traduites.
- Les modèles utilisant Inter ou Literata affichent leur vraie police ; l’ancien libellé affichait Helvetica par défaut.
- Le défilement du grand atelier est réservé au contenu : le bouton de retour reste dans la fenêtre. Le diagnostic initial mesurait une barre située à −151 px, puis −1 044 px avec du texte à 200 %. Après correction, sa position est 0 et le conteneur de contenu reste défilant.
- Sur petit écran, les choix Portrait/Paysage passent sur une colonne à partir d’un agrandissement de texte de 150 %, afin de garder les mots lisibles.

## Vérifications

La suite frontend complète a réussi : **1 814 tests, 222 fichiers** (`desktop/.qa/document-editor-full-tests.log`). Neuf nouveaux cas couvrent la conservation des textes, des plages UTF-16, des styles, des valeurs et des paramètres des traductions. TypeScript et build Vite réussissent. Le générateur de palette sombre ne produit aucune modification. Le build garde son avertissement de fragments supérieurs à 500 ko.

La recette navigateur utilise les vrais composants de Paramètres et du studio. Chaque scénario parcourt les 25 outils, vérifie le clavier et la conservation du brouillon, crée puis réapplique un modèle, modifie une mesure, met un passage en gras, remplace du texte et contrôle la récupération après une erreur locale puis une erreur PDF simulée. L’enregistrement récupéré conserve la police Inter, le texte saisi et le modèle. Les quatre catégories de rendu sont appelées.

Matrice finale et captures : `desktop/.qa/document-editor-languages/proof.json`, **16 parcours réussis et 400 accès aux outils**, Edge/WebKit, 320/1 440 px, FR/DE/IT/EN. Les 34 fichiers `*-viewport.json` consignent la position de la barre et le défilement : aucun déplacement de la barre hors écran ni défilement du dialogue extérieur. L’allemand à 320 px est également contrôlé avec un texte à 200 %. Le menu des outils est vérifié en sombre puis en clair sur mobile ; le parcours avancé est en clair. Les captures relues couvrent la validation, les contrôles de mise en page et l’agrandissement. Deux passages visuels ont conduit à la correction du défilement et des formats agrandis ; aucune refonte de marque.

## Limites

Données, enregistrement et réponses PDF sont fictifs et isolés du compte. Les PDF sont des fichiers de référence statiques ; le banc substitue Helvetica à Inter et Times à Literata pour ces aperçus. **Cette recette ne vérifie donc pas le rendu natif de ces polices, l’export PDF actuel, une sauvegarde disque réelle ou une synchronisation entre appareils.** Ces derniers essais relèvent d’autres preuves et ne sont pas déduits des contrôles navigateur.

Aucun installateur n’est compilé ou publié par ce lot. La version Windows installée a été relue à **1.90.5** ; aucun processus Zentra n’était présent lors du contrôle. Les restrictions du compte Supabase et du planificateur GitHub restent à résoudre selon les relevés de l’état de livraison. Aucun état global « prêt pour les clients » n’est annoncé.
