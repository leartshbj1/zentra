# Zentra — état courant des livraisons

Mis à jour le 27 septembre 2026, 22 h 50 (Europe/Zurich). L’objectif premier client reste en cours : les vingt points ne sont pas clos.

## Version 1.90.6 publiée ; installation locale Windows refusée

Les douze fichiers de la [release 1.90.6](https://github.com/leartshbj1/zentra/releases/tag/v1.90.6) sont publics et leurs empreintes correspondent aux fichiers vérifiés. Les quatre téléchargements principaux répondent HTTP 200 avec les tailles attendues à 22 h 11. **Sites 292** est publié à 22 h 19 ; la page de téléchargement et les canaux Windows/macOS proposent 1.90.6. Les trois manifestes répondent HTTP 200 anonymes, `no-store`, avec le contenu exact à 22 h 20 ; un canal inconnu répond 404.

**Le PC de l’utilisateur reste en 1.90.5.** L’essai du vrai bouton de mise à jour, exécuté sur l’entreprise fictive séparée, détecte 1.90.6 en 2 373 ms, télécharge le paquet, valide sa signature puis échoue au lancement de l’installateur : erreur Windows 4551. Les événements Code Integrity 3033/3077 à 22 h 22 confirment une exigence de signature/politique d’application. Aucun réglage de sécurité modifié, aucun contournement ni second installateur lancé. L’exécutable installé garde exactement son empreinte précédente. **La réussite de l’installation cloud ne prouve donc pas une réussite sur ce PC.**

L’instance fictive de test est fermée. Les vérifications après refus, après exports et après fermeture conservent les 110 tables comparées, les trois fichiers et les montants : 1 000 CHF facturés, 250 CHF reçus, 750 CHF restant, 5 000 CHF de salaire brut fictif. SQLite intègre. L’entreprise réelle et la licence de l’utilisateur n’ont pas été remplacées.

## Provenance et contrôles des paquets

Source applicative gelée **`9ec8e782a160e7fe2cdf3b853e19e54bbfa64a01`**, branche `codex/first-client-release-1906`. L’IPA utilise **`805cc9b0c1ad6ff75581eee7296d3a842bfa6b27`**, cible du tag `v1.90.6` : seuls sept fichiers de fabrication, de contrôle et de documentation diffèrent. L’équivalence du code applicatif est vérifiée avant publication. Ne pas déplacer les branches gelées ni le tag.

| Plateforme | Fichier principal | Vérification | Limite |
|---|---|---|---|
| Windows x64 | `Zentra_1.90.6_x64-setup.exe`, 24 536 107 octets | Build 150 ; installation/démarrage/relancement cloud 154 ; signature updater et icônes | Pas d’Authenticode ; lancement local refusé par Code Integrity |
| macOS universel | `Zentra_1.90.6_macos-universal.dmg`, 54 742 957 octets | Build 152 ; arm64/x86_64 ; démarrage/relancement isolés, SQLite 60 ; signature updater | Signature ad hoc, sans notarisation ni recette client sur Mac physique |
| iPhone | `Zentra-1.90.6-iPhone-unsigned.ipa`, 27 384 572 octets | Build 153 ; arm64 iPhoneOS 15+ ; icônes iPhone/iPad compilées identiques aux pixels approuvés | IPA non signé, sans essai physique ni publication App Store |
| Android | `Zentra-1.90.6-Android-arm64-test.apk`, 122 885 130 octets | Build 151 ; alignement 16 K, certificat persistant, segments ELF et 969 ressources préservés | Certificat de test, débogable, sans essai appareil ni publication Play Store |

L’IPA initiale du build 152 contenait l’icône Tauri et a été **rejetée, jamais publiée**. Le correctif copie les icônes après l’initialisation Xcode ; cinq tests et un contrôle des pixels compilés empêchent sa réapparition. La signature updater ne remplace pas une signature de distribution du système. Les anciens manifestes Supabase restent inchangés.

Preuves : `outputs/release1906/{SOURCES.json,source-equivalence-proof.json,github-published-proof.json,public-head-proof.json,site-publication-proof.json,update-channel-live-proof.json}`, répertoires `windows`, `smoke-windows`, `apple/macos`, `smoke-macos`, `iphone-corrected/iphone`, `android-signed`. L’ancien dossier `apple/iphone` est explicitement rejeté.

## Contenu et validation fonctionnelle

1.90.6 inclut les lots Détails Automation, Rendez-vous Automation, Navigation multilingue des documents et Éditeur multilingue, précédemment postérieurs à 1.90.5. Les outils sont traduits en FR/DE/IT/EN ; le retour de l’atelier reste accessible au défilement, les formats se réorganisent avec le texte agrandi et les noms des polices sont corrigés. Le journal ouvre les rendez-vous au jour exact et distingue données absentes, dates invalides et éléments reçus. Les données et modèles de l’utilisateur sont conservés.

- 1 814 tests frontend réussis au dernier lot ; 14 contrats de livraison, TypeScript, build et 50 actifs de marque avant gel. Les lots décrivent leurs parcours Edge/WebKit et leur portée.
- Build Apple : 21 tests de composition PDF et 61 tests frontend de l’éditeur réussis. Ce n’est pas un test de connexion réelle ni d’appareil mobile.
- Sur la version Windows **1.90.5**, 42 navigations natives sur 14 écrans et petite entreprise fictive : médiane 45 ms, p95 345 ms, maximum 362 ms, aucune erreur JS ni longue tâche détectée. Aucun résultat 1.90.6 local n’est déduit.
- Toujours sur **1.90.5**, huit PDF réellement exportés par la commande native : devis, facture, comptes, paie, avec Inter et Literata. Les 14 pages sont rendues et inspectées ; polices embarquées, logos, gras/italique/soulignement, montants et orientation paysage vérifiés. Durées d’export 11–14 ms sur ce petit exemple. Destination fournie directement, sélecteur système non testé. Les sources Rust du moteur sont identiques à 1.90.6, mais cela ne remplace pas une recette de ce binaire sur ce PC.
- Détail observé dans 1.90.5/1.90.6 : « Fonds propres » peut finir une page alors que ses lignes commencent sur la suivante. **Corrigé dans la source postérieure `4f9ca690`, non publiée** : rubriques avec leur première ligne, colonnes répétées sur les très longues lignes et contrôle du bilan avec son total. 62 tests natifs passent ; neuf exemples et 41 pages sont rendus et inspectés. [Portée et preuves](PAGINATION-BILANS-20260927.md). Le job cloud 155 réussi porte sur le premier commit `bb266a50`, pas sur les deux derniers ajustements.

Preuves natives : `outputs/release1906/upgrade-smoke/{updater-check-proof.json,updater-ui-events.json,updater-install-refused-proof.json,windows-code-integrity-refusal.json,navigation-1.90.5.json,native-pdf-export-proof.json,native-pdf-checks.json}` et `outputs/release1905/upgrade-smoke/{after-updater-refused,after-pdf-export,final-closed}-snapshot.json`. Aucun envoi de document, aucune création de compte et aucune modification de données réelles lors de cette recette.

## Site, comptes et traitement autonome

Sites **292**, source `20ecc8c536df184ac1d75f095d52d6ef4d70bc49`, environnement 37, déploiement `appgdep_6ab97a5521b88191868471bd3bba8858`, sauvegarde avec archive vérifiée. Publication réussie à 22 h 19. Quatorze tests, TypeScript, marque et build réussis. Les reprises de préparation n’ont changé ni dépendance ni contenu : Bash ajouté au PATH de la commande, puis `TAR_OPTIONS=--force-local` pour traiter le chemin Windows comme local.

**Comptes toujours indisponibles au contrôle de 22 h 37** : connexion synthétique HTTP 503, `Retry-After: 60`, `no-store`, avec l'origine attendue. Aucun compte ni e-mail créé. Le contrôle direct Supabase de **20 h 05** confirmait HTTP 402, quotas de stockage et transfert dépassés ; il n’a pas été répété à 22 h 37. L’intervention d’hébergement attendue et les recettes connectées restent ouvertes. Voir `outputs/release1906/auth-readiness-latest.json` et `outputs/release1905/account-health-latest.json`. Le premier contrôle sans en-tête Origin a été refusé HTTP 403 par la protection normale : ce n'est pas la cause de l'indisponibilité.

**Planificateur non rétabli** : GitHub `master` contient le correctif `59dcf5ba`, après 36 tests ciblés ; l’essai `36339873810` de 20 h 14 a été refusé avant exécution pour facturation. Workflow désactivé de nouveau, aucun drapeau d’arrière-plan ajouté. Aucun traitement réel avec apps fermées, moniteur externe ou alerte reçue encore prouvés. Voir [PLANIFICATEUR-ETAT-20260927.md](PLANIFICATEUR-ETAT-20260927.md) et [SUPERVISION-SERVICES-20260927.md](SUPERVISION-SERVICES-20260927.md).

## Travaux restant ouverts

Rétablir les comptes et le traitement autonome ; terminer le parcours réel inscription/paiement/invitation/deux appareils/reprise hors ligne ; rendre la distribution acceptable aux systèmes sans abaisser leur sécurité ([diagnostic et parcours Windows](SIGNATURE-WINDOWS-20260927.md)) ; valider les appareils et sélecteurs natifs ; poursuivre traduction, accessibilité et pagination des autres écrans. Les essais locaux ne prouvent pas une capacité de 150 entreprises ni la fermeture des vingt points.

L’historique détaillé de 1.90.5 et de sa restauration effective est conservé dans [HISTORIQUE-LIVRAISON-1905-20260927.md](HISTORIQUE-LIVRAISON-1905-20260927.md). La restauration `.zentra` depuis un dossier source inaccessible a bien conservé base, documents et logo sur ce profil fictif ; aucune restauration sur deux appareils connectés n’en est déduite.
