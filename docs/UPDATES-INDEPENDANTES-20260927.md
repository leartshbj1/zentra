# Mises à jour séparées du service de compte

## Cause et périmètre

Le 27 septembre 2026 à 17 h 26 (heure suisse), le GET public Supabase `/auth/v1/settings` répond 402 en 308 ms avec `exceed_egress_quota` et `exceed_storage_size_quota`. Il ne crée ni compte ni e-mail. Cette lecture confirme une restriction fournisseur, pas une erreur de mot de passe. Les réglages et journaux d’usage complets restent à consulter dans l’organisation Supabase.

Selon la documentation Supabase consultée le même jour, le transfert déjà consommé ne peut pas être réduit rétroactivement. Supprimer des fichiers ne remet donc pas ce compteur à zéro. La taille de stockage retenue est une moyenne sur la période, pas seulement le total instantané. Le rétablissement peut nécessiter le renouvellement des quotas ou un changement d’offre/plafond autorisé. Aucun changement de facturation ni aucune suppression n’a été effectué.

Sources : [transfert](https://supabase.com/docs/guides/platform/manage-your-usage/egress), [stockage](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size), [restrictions](https://supabase.com/docs/guides/platform/billing-faq).

## Canal indépendant

Les nouvelles adresses `/updates/latest-windows.json`, `/updates/latest-macos.json` et `/updates/latest.json` servent des métadonnées incluses dans le déploiement Sites. Aucune session, requête Supabase, lecture de stockage ou requête GitHub à chaque vérification. Réponse JSON `no-store`, fichier inconnu 404. Les fichiers lourds restent téléchargés directement depuis la release GitHub versionnée, sans proxy dans le serveur de compte.

Le contenu vise les paquets **1.90.4** déjà publiés et testés au démarrage. Les nouvelles corrections natives postérieures ne sont pas incluses dans ces paquets. Les signatures Tauri sont reprises à l’identique et revérifiées sur les octets locaux ; SHA-256 et tailles concordent avec les métadonnées GitHub relues le 27 septembre. Windows reste sans Authenticode et macOS non notarié ; ce canal ne change pas leur statut de distribution.

Le client natif en préparation accepte uniquement le dépôt `leartshbj1/zentra`, une version et un nom d’installateur concordants. Une URL temporaire du CDN n’est admise qu’après un lien de release autorisé, avec l’identifiant de dépôt 1355157107. Les redirections sont contrôlées avant leur suivi ; HTTPS, port 443, limites de taille et signature obligatoire sont conservés. Les scripts de construction/staging ciblent le nouveau canal et des fichiers versionnés GitHub.

## Transition et recette

Les manifestes Supabase historiques et `public/downloads/latest.json` restent inchangés. Les binaires 1.90.4 installés pointent encore vers l’ancien canal : publier ces nouveaux endpoints ne les réécrit pas. Le nouvel installateur sera nécessaire, ou un pont de transition sera à publier après rétablissement de l’ancien hébergement. Ne pas effacer les anciens fichiers tant que ce parcours n’est pas validé.

14 tests serveur valident la réponse anonyme même quand les services externes échouent, les plateformes proposées, les liens immuables et les fichiers inconnus. 12 tests frontend/natifs statiques valident la préparation et l’interface d’actualisation. Le test natif Windows distant valide les règles de transport ; sa preuve finale doit être conservée dans le suivi natif. La recette installation → recherche → téléchargement → installation → relancement d’une **nouvelle** version reste nécessaire avant promotion générale.
