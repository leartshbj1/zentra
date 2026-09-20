# Réparer un ancien lien sur une entreprise locale vide

L’outil `repair_empty_company_link` est réservé à une intervention explicite sur un appareil fermé, après sauvegarde du profil. Il est compilé uniquement avec la fonctionnalité Cargo `maintenance` ; il n’est ni exposé à la WebView ni inclus dans les versions normales.

Il couvre un cas précis : un profil encore configuré et connecté au propriétaire courant, sans documents métier ni réservations de numéros, conserve des métadonnées de synchronisation d’une ancienne entreprise. Le serveur du compte actuel ne doit avoir aucun instantané ni partage actif.

L’outil vérifie l’adresse attendue, le rôle propriétaire, l’identité d’installation et la destination côté serveur. Il refuse les changements en attente, les conflits et toute table de données non vide, à l’exception de la configuration, des logos, de la licence et des métadonnées locales. Un ancien compteur de synchronisation n’est pas comparé à celui d’une nouvelle base vide.

Après une sauvegarde native supplémentaire, il retire uniquement les anciennes préférences de liaison et utilise le protocole de publication existant : préparation avec révision attendue, numérotation partagée, transfert vérifié, validation serveur et enregistrement de la référence locale. La réponse finale vérifie la révision commune, l’absence de changements en attente et l’accès Automation.

Exemple d’utilisation après fermeture et sauvegarde :

```powershell
cargo build --target x86_64-pc-windows-gnu --features maintenance --example repair_empty_company_link
./target/x86_64-pc-windows-gnu/debug/examples/repair_empty_company_link.exe --apply-empty-company-repair 'PROFIL_ABSOLU' 'PROPRIETAIRE_ATTENDU' 'ANCIENNE_ORGANISATION'
```

Ne pas rétablir aveuglément les anciennes métadonnées après une erreur réseau : un envoi peut avoir été accepté. Contrôler la révision serveur et les préférences locales avant toute reprise. L’outil refuse volontairement une seconde réparation si le lien ou la destination a changé.

## Vérification du 20 septembre 2026

Le test de non-régression couvre le compteur d’une ancienne base, une organisation inattendue, un conflit, un client existant et une réservation de numérotation. Il est passé avec la fonctionnalité de maintenance activée.

Une intervention autorisée sur Windows 1.74.1 a ensuite terminé le protocole natif avec une révision identique locale/serveur, aucun envoi en attente et Automation actif. La comparaison intégrale des tables avec la sauvegarde a trouvé uniquement les modifications attendues du compteur de synchronisation, du lien de numérotation et des plages de numéros. La configuration, les logos, les fichiers joints, la session, la licence et l’identité d’installation ont été conservés. Les contrôles SQLite d’intégrité et de clés étrangères sont passés.

Le lancement direct du CLI doit pouvoir trouver `WebView2Loader.dll` dans le répertoire de construction Tauri Windows. Utiliser ce répertoire dans le `PATH` du processus, comme le fait Cargo ; aucune installation ou modification de sécurité Windows n’est requise.
