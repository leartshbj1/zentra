# Compiler Zentra pour Apple sans Mac personnel

Le compte individuel Codemagic construit les paquets sur une machine Mac M2. Il utilise le dépôt public comme source, sans GitHub Actions. Les paquets destinés aux clients sont hébergés sur Supabase Storage après vérification et signature locale des mises à jour.

## Lancer une compilation

1. Ouvrir l’application `zentra` dans Codemagic et choisir la branche de publication validée.
2. Choisir `macos-public` pour le Mac universel Intel/Apple Silicon, ou `iphone` pour un IPA public sans signature Apple.
3. Lancer la compilation et attendre la réussite de toutes les étapes. Télécharger les fichiers, `SHA256SUMS.txt` et la preuve de source.
4. Vérifier les sommes SHA-256, la version et la source avant de publier. Le Mac doit contenir les deux architectures et le canal `latest-macos.json`.
5. Signer l’archive Mac `.app.tar.gz` avec la clé de mise à jour locale existante. Cette clé privée ne doit jamais être envoyée au service de compilation.
6. Publier d’abord les fichiers immuables, les retélécharger pour vérifier leurs sommes, puis seulement mettre à jour le manifeste. Le manifeste Mac utilise la cible personnalisée `macos-universal` configurée par l’application. Garder une copie du manifeste précédent.

Les anciens Mac configurés sur le manifeste partagé `latest.json` doivent installer manuellement cette nouvelle version pour passer au canal indépendant. Ne pas modifier le manifeste partagé sans vérifier toutes ses plateformes.

## Exemplaire iPhone personnel

La branche personnelle propose le workflow `iphone-personal`. Il reçoit seulement la licence propriétaire déjà signée via une variable secrète Codemagic, jamais sa clé de signature. L’IPA obtenu est privé : ne pas le placer sur Supabase public, sur une release publique ou sur le site client.

L’activation automatique conserve les contrôles habituels : signature, identité de l’installation, validation serveur et stockage protégé. Elle s’applique uniquement à une installation neuve ; une identité ou licence existante n’est pas remplacée. Une connexion Internet est nécessaire au premier lancement. L’installation effective et l’activation sur un iPhone doivent encore être confirmées sur l’appareil.

## Gratuité et distribution Apple

L’offre individuelle comprend actuellement 500 minutes de Mac M2 par mois et une compilation à la fois. Vérifier le quota avant les prochains builds ; cette procédure n’active pas de facturation. Source : [tarifs Codemagic](https://docs.codemagic.io/billing/pricing/).

La compilation gratuite ne fournit pas de certificat Apple. Le paquet Mac a une signature ad hoc et n’est pas notarié. L’IPA doit être signé pour l’installation, par exemple avec Sideloadly ou AltStore. App Store/TestFlight et la distribution Mac notariée restent liés à l’adhésion Apple Developer.

Le stockage Supabase gratuit limite chaque fichier à 50 Mo. Vérifier la taille des paquets avant publication. Sources : [limites de fichiers Supabase](https://supabase.com/docs/guides/storage/uploads/file-limits), [distribution Apple](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).
