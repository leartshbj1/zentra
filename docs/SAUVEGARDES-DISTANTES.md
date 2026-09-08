# Sauvegardes complètes distantes

Ce coffre protège une copie complète de l’entreprise hors de l’appareil. Il ne réalise pas la fusion des modifications de plusieurs collaborateurs.

## Parcours

- Dans Paramètres → Sauvegardes et mises à jour, le titulaire ou un administrateur connecté peut créer une copie et activer une copie quotidienne. L’application doit être ouverte ; aucun service système n’est installé. Les autres rôles n’ont pas accès à ces archives qui contiennent les salaires.
- Un fichier `.zentra` publié en 1.46.1 inclut la base et les pièces jointes. Le format 2 en préparation ajoute le dossier des exports, comme décrit ci-dessous. Les jetons du compte sont dans un coffre propre à l’appareil, hors de l’archive ; la table de licence est vidée puis le fichier SQLite compacté avant archivage.
- L’envoi conserve son identifiant et son archive locale après une interruption ou un redémarrage. Il reprend par fragments de 8 Mio avec SHA-256 ; une réponse perdue ne crée pas de doublon. La copie n’est restaurable qu’après réception de tous les fragments.
- Le coffre conserve au maximum 50 copies et 10 Gio par entreprise ; une copie est limitée à 512 Mio. Un coffre plein bloque les nouveaux envois et affiche une erreur. La suppression est volontaire, sans rotation qui effacerait silencieusement une ancienne version.
- Sur un nouvel appareil, la connexion à l’entreprise donne accès à « Retrouver mon entreprise » dès l’accueil de configuration. La restauration vérifie fragments, empreinte globale, archive, schéma et intégrité de la base. Elle garde une copie locale de sécurité et l’identité/licence du nouvel appareil.
- Les changements intervenus dans SQLite pendant le téléchargement font refuser le remplacement. Une copie corrompue ou d’un schéma plus récent ne doit jamais remplacer les données actives.
- La restauration contrôle aussi la chaîne SHA-256 du journal d’audit et refuse les écritures comptables vides ou déséquilibrées avant le remplacement.
- Depuis Compte → Mes sauvegardes, le titulaire ou un administrateur peut télécharger une archive complète avec sa connexion web, sans l’ancien appareil et même après la fin de l’abonnement. Chaque fragment et l’empreinte globale sont contrôlés pendant le téléchargement ; une interruption ne produit pas de fichier annoncé complet. Les rôles restreints et les membres révoqués sont refusés.
- La restauration locale reste disponible sur une installation neuve ou pour le titulaire/administrateur dont la licence est expirée ou inactive. Elle conserve la licence de destination : les écritures métier restent bloquées tant que l’abonnement n’est pas actif.
- Les fiches de salaire importées retrouvent leur fichier par sa référence gérée et son empreinte dans le profil de destination, y compris entre systèmes différents. Leur ancien chemin reste dans la preuve immuable ; il n’est jamais utilisé pour lire un fichier hors du nouveau profil.
- Une suppression interrompue reste visible comme « Suppression à terminer ». Les envois tardifs ne ressuscitent pas la copie. Un envoi local peut aussi être abandonné hors ligne ; une éventuelle copie incomplète dans le coffre doit alors être supprimée séparément.

## Éléments techniques

### Exports historiques dans le format 2 — code natif non distribué

Les nouvelles sauvegardes locales incluent `database.sqlite3`, `attachments/` et `exports/`. Les XML TVA et les ZIP de clôture enregistrés sont figés et vérifiés contre la copie SQLite avant l'archivage : empreinte du XML, manifeste de clôture, lignes SHA-256 et contenu de chaque pièce déclarée. Les autres exports présents, notamment les CSV et PDF, sont aussi conservés, avec leurs sous-dossiers. Une référence comptable absente ou altérée empêche de publier une nouvelle sauvegarde complète ; aucun fichier final ni preuve de réussite n'est laissé après un échec d'écriture.

Les limites locales restent distinctes du coffre : 10 Gio de base, 50 Gio de pièces jointes et 10 Gio d'exports décompressés ; les exports enregistrés suivent aussi les limites de vérification de l'historique (50 000 références et 512 Mio par fichier). Les lectures sont bornées pendant le traitement, même si les tailles annoncées dans le ZIP sont falsifiées. Chemins hors dossier, noms non portables, liens et collisions de casse sont refusés. L'archive de sauvegarde ne peut pas être créée dans les dossiers actifs `attachments` ou `exports`.

La restauration valide la copie reçue avant de remplacer ensemble la base, les pièces jointes et les exports. Une erreur de finalisation rétablit les trois éléments précédents. La copie de sécurité locale conserve aussi les anciens exports, y compris les fichiers qui n'appartiennent plus au profil restauré. Lorsqu'une restauration répare un export déjà perdu ou corrompu sur le profil actuel, cette copie interne conserve l'état trouvé sans le déclarer sauvegarde complète valide ; le contrôle strict de l'archive entrante reste obligatoire. Si l'état précédent était déjà incohérent, sa copie de secours peut nécessiter une réparation avant d'être elle-même restaurable.

Le lecteur accepte encore le format 1 (`.zentra`, `.elyko`, `.hchantier`). Ces anciennes archives ne contiennent généralement pas les exports historiques : leurs lignes de registre ne suffisent pas à reconstituer les octets originaux. La confirmation de restauration locale et distante le signale. Les exports du profil remplacé ne sont jamais mélangés à ceux de l'archive ; ils restent dans la copie de sécurité. Le format 2 exige une application mise à jour et n'est pas lisible par les installateurs publics 1.46.1.

Les tests couvrent les vrais XML TVA et ZIP de clôture produits par l'application, leur restauration dans un profil isolé, les registres inchangés, les fichiers absents ou altérés, la réparation d'un export local endommagé, le retour arrière, les limites et la compatibilité du format 1. La recette du coffre HTTPS avec ces nouveaux exports et l'essai sur un second appareil physique restent à réaliser avant de distribuer ce code natif.

Validation locale du 8 septembre 2026 : **39 tests natifs réussis, zéro échec**, en 103,75 secondes ; la recette HTTPS reste explicitement ignorée dans ce filtre. Les scénarios existants de facturation, banque, avoirs, projets, licence et fichiers hors ligne traversent également la sauvegarde puis la restauration. Clippy sur toutes les cibles passe sans avertissement en 21,12 secondes. TypeScript et la compilation de l'interface passent ; Vite signale toujours certains fragments de plus de 500 Ko. Aucun test sur un second appareil physique ni nouvel installateur n'est revendiqué.

Routes privées `/api/backups`, `/api/backups/item`, `/api/backups/chunk`, authentifiées par la session d’appareil existante. Chaque accès est rattaché côté serveur à l’entreprise et au rôle. Stockage D1 pour les réservations/métadonnées et R2 pour les octets ; aucun lien public d’objet. Migration `0011_burly_thing.sql` générée depuis le schéma Drizzle.

Le backend natif `cloud_backup.rs` conserve seulement les préférences et l’envoi en attente dans le profil local. Le planificateur de l’interface demande une vérification toutes les cinq minutes et à la reprise réseau ; le backend applique l’intervalle quotidien et un verrou d’opération. Les erreurs sont conservées et signalées dans l’interface.

## Preuves de recette du 8 septembre 2026

- 229 tests serveur passent, dont 21 pour le coffre et sa récupération web : transferts interrompus, rejeu, altération, quotas, rôles, révocation, isolation, suppression concurrente, reprise d’un nettoyage R2 en échec, récupération après résiliation et téléchargement de plusieurs fragments avec contrôle global.
- 17 tests natifs de sauvegarde passent : archive en attente après redémarrage, refus d’un changement d’entreprise, restauration base + pièce jointe dans une installation neuve, refus d’un audit altéré et d’un journal vide. Les tests existants confirment la conservation de la licence de destination et le retour arrière en cas d’échec d’installation.
- Deux tests natifs de licence confirment la récupération avec licence absente/inactive sans réactiver les écritures, et le refus de remplacement pour un rôle en lecture seule.
- Compilation de l’interface et contrôle TypeScript réussis ; 742 tests d’interface existants passent.
- Recette CUA sur une interface fictive à 320 × 568 et 1440 × 900 : création, reprise après coupure simulée, confirmation intégrée, restauration, vues hors ligne et rôle restreint. Aucun débordement horizontal global ; commandes mobiles de 44 px de haut.
- Page de récupération web contrôlée avec données fictives à 320 × 568 et 1440 × 900 : copies disponibles, coffre vide, erreur et connexion. Aucun débordement horizontal ; commandes de téléchargement et sélection de 48 px de haut.

Le service de sauvegarde a été publié le 8 septembre (version du site 68), puis la récupération web dans la version 69, source `730d8b2`. La page publique répond 200 et les deux API privées refusent une requête sans connexion (401).

Une recette native HTTPS complète a ensuite réussi contre le site public version 70 : deux profils Windows temporaires avec des identités d’installation différentes, autorisés par le parcours de compte normal dans l’entreprise fictive existante. L’archive de 9 518 143 octets contenait un projet et une pièce jointe fictifs. Après envoi du premier fragment, le profil a été rouvert ; le transfert a repris, puis la seconde installation a téléchargé et restauré la base et la pièce jointe. Le SHA-256 de la pièce restaurée correspond exactement à la source. Le test a supprimé sa propre archive et révoqué ses deux sessions. Aucun paiement réel ni document client n’a été utilisé.

La source native testée est `75d5bb4`, avec la clé publique de licence de production à la compilation. Un premier essai sans cette clé a été refusé avant l’envoi ; sa session a été révoquée depuis le compte. Un deuxième essai a expiré pendant le blocage d’une ancienne confirmation native du navigateur. La nouvelle interface utilise une confirmation intégrée, et l’onglet bloqué a été rechargé. Les tests de compte couvrent désormais aussi la révocation d’une session conservée dans un échange de licence inachevé.

Ces deux profils tournent sur le même ordinateur : cette preuve ne remplace pas l’installation et l’essai sur deux appareils physiques. Les nouveaux installateurs restent à publier et à valider.

### Reproduire la recette HTTPS

Exécuter uniquement dans une entreprise de test déjà autorisée. Le test est ignoré dans la suite ordinaire, attend deux approbations par le navigateur et utilise le service réellement publié. Il ne lit aucune donnée du profil utilisateur installé.

```powershell
$env:HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL = (Get-Content desktop/src-tauri/license-public-key.b64url -Raw).Trim()
try {
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --lib live_https_backup_restores_two_chunks_on_an_independent_installation -- --ignored --nocapture
} finally {
  Remove-Item Env:HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL -ErrorAction SilentlyContinue
}
```

Les journaux ne doivent contenir que les liens courts d’approbation, les références de test et les empreintes ; jamais les jetons de session ou de licence. Vérifier `QA_CLEANUP_COMPLETE` et l’absence des deux appareils temporaires dans le compte après la recette.

## Reste à fermer

La session native utilise encore la politique générale de compte ; la récupération après résiliation passe par la connexion web. La réplication métier concurrente reste une priorité indépendante. Le téléchargement web suit les API de streaming et de chiffrement documentées par [Cloudflare R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) et [Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).
