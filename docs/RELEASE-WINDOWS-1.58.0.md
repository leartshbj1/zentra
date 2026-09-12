# Windows 1.58.0

## Contenu

- Choix de police et de taille pour les mots sélectionnés dans les introductions, conditions et pieds de page des modèles de factures, devis, bilans et fiches de salaire. La mise en forme est conservée dans les PDF et les documents longs se répartissent en pages selon la taille réelle des caractères.
- Saisie des heures avec deux champs, heures et minutes, coût proposé depuis le collaborateur, distinction claire entre coût et prix client, résumé et erreurs placées à l’écran. Les saisies et le chronomètre empêchent les doubles enregistrements et gardent les informations en cas d’erreur.
- Facturation des heures : les choix restent mémorisés pour chaque projet et après actualisation. Les heures nouvellement disponibles ne sont pas cochées automatiquement. Une facture créée dont la relecture a échoué se récupère sans recommencer l’écriture.

## Périmètre

Windows x64, identifiant `ch.helvichantier.desktop` et schéma SQLite 59 conservés. Les présentations déjà figées restent inchangées. Les nouvelles options de texte complètent l’atelier existant ; le certificat annuel officiel garde son formulaire réglementaire. Aucun nouvel installateur macOS, iOS ou Android n’est compris dans cette livraison Windows.

La signature Tauri/Ed25519 authentifie le lot de mise à jour. Aucun certificat Authenticode n’est disponible : Windows peut afficher « Éditeur inconnu ».

## Validation

Les 1 085 tests d’interface passent. Les tests natifs ciblés des documents (21) et du temps (10) passent ; ils vérifient notamment les totaux, la présentation des documents déjà émis, l’atomicité et l’idempotence de la facturation des heures. Les huit parcours de saisie et facturation passent également dans le projet principal sur Edge et WebKit, en petit mobile, mobile, paysage et ordinateur. Les parcours de typographie et d’édition de texte passent aux largeurs 320, 390 et 1 440 pixels ; les PDF natifs ont été rendus et contrôlés.

## Livraison

Préparation en cours. La compilation, la signature, le contrôle du programme et la publication doivent encore être confirmés pour ce lot exact.
