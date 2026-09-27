# Un canal de mise à jour indépendant des comptes

## État courant

Le serveur Sites **288** est publié le 27 septembre 2026 à 17 h 37 (Europe/Zurich), source `1271b2f7fbcad8776c684d02b6a0e4b4c22bcdf3`, configuration 36. Déploiement `appgdep_6ab938382c0881919c5865425fe63eb3` réussi.

Les contrôles anonymes à 17 h 38 réussissent sur `https://zentraapp.ch/updates/latest-windows.json`, `latest-macos.json` et `latest.json` : HTTP 200, JSON exact de la source publiée, `no-store`, aucun cookie de compte. Cloudflare ajoute son cookie technique `__cf_bm` ; le premier contrôle trop strict refusait ce cookie, puis l’assertion a été corrigée pour refuser les sessions applicatives sans confondre le cookie du proxy. Un fichier inconnu retourne 404. Aucun jeton de session n’est envoyé par ces essais.

Le service propose les fichiers **1.90.4 déjà publiés**, pas un nouveau build. Leurs signatures Ed25519 et commentaires signés ont été revérifiés localement. Les empreintes correspondent aux métadonnées GitHub relues :

- Windows : `B07F2EE1076793B9A9F7B0683A9FB1E42A00AC5B5A8CA378BB955082E019EF14`, 24 448 565 octets.
- Archive `.app.tar.gz` Mac : `E33C7C390F8BE32D08217AEB813ADE859EF53F8C4FE2209633BF54A1C096DDA4`, 53 326 403 octets.

## Modification native

Source `8f136cc47e7c61bd733e10105c8866ee336ffae0` : les prochains builds ciblent le site pour le manifeste et GitHub pour les fichiers. Le client n’accepte que les installateurs du dépôt `leartshbj1/zentra` dont le nom correspond au numéro de version, puis les redirections du CDN pour l’identifiant de dépôt 1355157107. Chaque redirection est vérifiée avant contact, avec HTTPS/443, cinq sauts au maximum, plafond 256 Mio et signature obligatoire avant installation.

Les anciens liens Supabase restent autorisés pour compatibilité. Les manifestes historiques et les paquets 1.90.4 sont inchangés. Ils contiennent encore leur ancien endpoint : une installation du nouveau paquet sera nécessaire tant que l’ancien hébergement est bloqué. Aucune mise à jour automatique des appareils existants n’est prétendue ici.

## Validation et limites

14 tests serveur et 12 tests frontend/contrat passent, syntaxe de quatre scripts PowerShell validée, TypeScript/lint/build serveur réussis. Les assertions de types manquantes dans le nouveau test serveur ont été corrigées avant publication. **Windows 144 a échoué avant exécution**, sur deux imports manquants dans le module de tests Rust. Correction `0de81490` ; **Windows 145** vérifie cette source exacte, statut dans `outputs/updater-channel-windows-145.json`. Les journaux 144 sont conservés, pas comptés comme réussite. Ce travail ne change ni la signature Authenticode, ni la notarisation Mac, ni les canaux mobiles. Aucun installateur nouveau n’est produit par ces jobs.

Il reste à figer et construire la prochaine version native, vérifier une vraie transition installation → recherche → téléchargement → installation → relancement, puis promouvoir le nouveau canal et organiser la transition des anciennes installations.

## Blocage Supabase séparé

Contrôle direct à 17 h 26 : `/auth/v1/settings` répond HTTP 402 en 308 ms avec `exceed_egress_quota` et `exceed_storage_size_quota`. Aucun compte ni e-mail créé. Les quotas ne sont pas rétablis par le nouveau canal. Le tableau de bord Usage/Billing est à vérifier ; une demande de capture est en attente car les outils de navigation échouent au démarrage. Aucune dépense, suppression de sauvegarde ou suppression de document effectuée.

La [documentation Supabase](https://supabase.com/docs/guides/platform/manage-your-usage/egress) précise que le transfert déjà consommé ne diminue pas après suppression de fichiers. Le [stockage facturé](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size) est une moyenne sur la période. Le rétablissement des quotas reste donc un préalable aux essais réels de connexion et de collaboration.
