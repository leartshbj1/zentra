# Signature des préversions Android

À partir de 1.32.0, les APK de test compacts utilisent une identité de signature persistante. Son certificat public est épinglé dans `desktop/android-preview-certificate.sha256`. Le workflow refuse de fabriquer un APK si le secret manque ou si le certificat diffère. Il ne génère plus de clé de remplacement.

Le magasin PKCS12 chiffré et son mot de passe sont conservés dans les secrets GitHub `ZENTRA_ANDROID_PREVIEW_KEYSTORE` et `ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD`. La copie locale est protégée par Windows DPAPI pour le compte qui l’a créée, dans `%LOCALAPPDATA%\Zentra\release-signing\android-preview-signing.dpapi`. Ne pas supprimer cette identité : la remplacer casse les mises à jour. Le fichier public de certificat ne permet pas de signer.

Les préversions publiées jusqu’à 1.31.0 utilisaient des clés éphémères différentes. Leur clé privée n’a pas été conservée : elles ne peuvent donc pas être remplacées directement par le nouvel APK. Exporter et vérifier une sauvegarde avant toute migration. La désinstallation d’Android efface le profil local ; aucune désinstallation automatique n’est effectuée. Cette transition doit être indiquée au téléchargement de 1.32.0.

Le contrôle `android-startup.yml`, avec `compact_preview=true` et `upgrade_from_run`, re-signe une ancienne construction comme **fixture isolée** avec la nouvelle identité. Sur émulateur uniquement, il crée un client et un projet, remplace l’APK avec `adb install -r`, puis vérifie l’identité de l’installation, ces données, un fichier témoin et l’intégrité SQLite après migration. Ce test ne prouve pas la possibilité de mettre à jour les anciens APK publics à signature éphémère.

Ces APK restent des préversions débogables, distinctes d’une distribution Google Play et de sa signature de production. La stabilité de la signature permet le remplacement manuel d’un APK compatible ; elle n’ajoute pas de téléchargement automatique ni de synchronisation des données entre appareils. Voir les [règles officielles de signature Android](https://developer.android.com/studio/publish/app-signing).
