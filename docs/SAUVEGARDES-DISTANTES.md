# Sauvegardes complètes distantes

Ce coffre protège une copie complète de l’entreprise hors de l’appareil. Il ne réalise pas la fusion des modifications de plusieurs collaborateurs.

## Parcours

- Dans Paramètres → Sauvegardes et mises à jour, le titulaire ou un administrateur connecté peut créer une copie et activer une copie quotidienne. L’application doit être ouverte ; aucun service système n’est installé. Les autres rôles n’ont pas accès à ces archives qui contiennent les salaires.
- Un fichier `.zentra` inclut la base et les pièces jointes. Les jetons du compte sont dans un coffre propre à l’appareil, hors de l’archive ; la table de licence est vidée puis le fichier SQLite compacté avant archivage.
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

Routes privées `/api/backups`, `/api/backups/item`, `/api/backups/chunk`, authentifiées par la session d’appareil existante. Chaque accès est rattaché côté serveur à l’entreprise et au rôle. Stockage D1 pour les réservations/métadonnées et R2 pour les octets ; aucun lien public d’objet. Migration `0011_burly_thing.sql` générée depuis le schéma Drizzle.

Le backend natif `cloud_backup.rs` conserve seulement les préférences et l’envoi en attente dans le profil local. Le planificateur de l’interface demande une vérification toutes les cinq minutes et à la reprise réseau ; le backend applique l’intervalle quotidien et un verrou d’opération. Les erreurs sont conservées et signalées dans l’interface.

## Preuves de recette du 8 septembre 2026

- 229 tests serveur passent, dont 21 pour le coffre et sa récupération web : transferts interrompus, rejeu, altération, quotas, rôles, révocation, isolation, suppression concurrente, reprise d’un nettoyage R2 en échec, récupération après résiliation et téléchargement de plusieurs fragments avec contrôle global.
- 17 tests natifs de sauvegarde passent : archive en attente après redémarrage, refus d’un changement d’entreprise, restauration base + pièce jointe dans une installation neuve, refus d’un audit altéré et d’un journal vide. Les tests existants confirment la conservation de la licence de destination et le retour arrière en cas d’échec d’installation.
- Deux tests natifs de licence confirment la récupération avec licence absente/inactive sans réactiver les écritures, et le refus de remplacement pour un rôle en lecture seule.
- Compilation de l’interface et contrôle TypeScript réussis ; 742 tests d’interface existants passent.
- Recette CUA sur une interface fictive à 320 × 568 et 1440 × 900 : création, reprise après coupure simulée, confirmation intégrée, restauration, vues hors ligne et rôle restreint. Aucun débordement horizontal global ; commandes mobiles de 44 px de haut.
- Page de récupération web contrôlée avec données fictives à 320 × 568 et 1440 × 900 : copies disponibles, coffre vide, erreur et connexion. Aucun débordement horizontal ; commandes de téléchargement et sélection de 48 px de haut.

Ces essais ne constituent pas encore une preuve de transfert du client natif vers le serveur public ni une installation sur deux appareils physiques. Le service de sauvegarde a été publié le 8 septembre (version du site 68), puis la récupération web dans la version 69, source `730d8b2`. La page publique répond 200 et les deux API privées refusent une requête sans connexion (401). Les nouveaux artefacts natifs distribués et l’essai natif HTTPS restent à vérifier avant d’annoncer cette priorité entièrement livrée.

## Reste à fermer

La session native utilise encore la politique générale de compte ; la récupération après résiliation passe par la connexion web. La réplication métier concurrente reste une priorité indépendante. Le téléchargement web suit les API de streaming et de chiffrement documentées par [Cloudflare R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) et [Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).
