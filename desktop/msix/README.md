# Zentra sur le Microsoft Store

Le Microsoft Store re-signe gratuitement les paquets MSIX après certification.
C'est ce qui retire l'avertissement SmartScreen « éditeur inconnu » pour les
installations faites depuis le Store, sans certificat payant.

## Ce que produit la CI

Chaque build de release Windows (`desktop/scripts/cloud-release-windows.ps1`)
emballe le même `Zentra.exe` que l'installateur NSIS dans un MSIX non signé,
avec `desktop/scripts/package-msix-windows.ps1` :

- `Zentra_<version>_x64-store-preview.msix` tant que `store-identity.json`
  contient `null` : identité fictive, refusée par le Store, utile seulement
  pour vérifier que le paquet se construit ;
- `Zentra_<version>_x64-store.msix` une fois l'identité Partner Center
  renseignée : c'est le fichier à téléverser dans Partner Center.

`provenance.json` décrit ce paquet sous `microsoftStore`. Le MSIX n'est jamais
proposé en téléchargement direct : non signé, il ne s'installe que via le Store.

## Différences avec l'édition NSIS

- Mises à jour : l'updater intégré se ferme tout seul quand l'app tourne dans
  un paquet (`running_from_msix_package` dans `app_updater.rs`). Le Store livre
  les mises à jour après chaque nouvelle soumission.
- Données : la virtualisation des écritures est désactivée
  (`unvirtualizedResources`). L'édition Store utilise donc le même profil
  `%LOCALAPPDATA%\ch.helvichantier.desktop` que l'édition NSIS, et les données
  restent sur le PC si le paquet est désinstallé.
- WebView2 : le paquet n'embarque pas l'installateur. Windows 11 et les
  Windows 10 à jour (2004 ou plus récent) l'ont déjà.

## Première publication

1. Créer le compte développeur sur https://storedeveloper.microsoft.com
   (gratuit).
2. Dans Partner Center, créer une app « MSIX or PWA » et réserver le nom
   « Zentra ».
3. Copier les trois valeurs de Product identity (Package/Identity/Name,
   Package/Identity/Publisher, Package/Properties/PublisherDisplayName) dans
   `store-identity.json`, puis lancer une release Windows.
4. Téléverser `Zentra_<version>_x64-store.msix` dans la section Packages.
5. Dans les notes de certification, justifier la capacité restreinte
   `unvirtualizedResources` : « Zentra est une application de gestion qui garde
   la base SQLite de l'entreprise dans %LOCALAPPDATA%. Les données doivent être
   partagées avec l'installateur classique et survivre à une désinstallation du
   paquet. » `runFullTrust` est la capacité standard des apps de bureau.
6. Fiche Store : description, captures, URL de la politique de confidentialité
   de zentraapp.ch, catégorie Business. Prix : gratuit au téléchargement,
   l'abonnement reste géré par Stripe (autorisé pour les apps hors jeux).
