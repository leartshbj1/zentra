# Zentra 1.64.0 — Mobile, apparence et accès d’équipe

Le menu mobile suit le doigt depuis le bord gauche, puis se referme par un geste inverse. Les déplacements verticaux, les champs et les lecteurs de documents ne déclenchent pas ce geste. Les commandes respectent les zones réservées de l’écran. Les devis, factures, PDF et images disposent du zoom à deux doigts et du déplacement dans le document.

Paramètres → Apparence propose Clair, Sombre et Automatique. Le choix est conservé sur l’appareil, appliqué dès le démarrage et transmis aux interfaces natives. Les surfaces sombres sont préparées à la compilation et ajustées par une palette sémantique. Les documents gardent leurs couleurs d’impression. Les options système de réduction des animations et de la transparence sont prises en compte.

Paramètres → Compte et équipe propose le partage des coordonnées, la création d’un lien d’invitation et l’annulation des invitations en attente. Les rôles et places sont contrôlés sur le serveur : Solo 1, Start 3, Pro 10, titulaire compris. Les invitations en attente réservent une place. Le destinataire accepte le lien avec sa propre adresse e-mail. Un nouveau code de connexion ne peut plus être remplacé par une réponse tardive du code précédent.

Au démarrage, Rejoindre une entreprise récupère son identité et son activité via Supabase. Aucun espace existant n’est remplacé. Le partage des fichiers de projets existant est conservé ; cette version ne synchronise pas toutes les entités commerciales ou les écritures comptables. Les invitations sont transmises par lien, sans envoi automatique d’e-mail.

## Contrôles avant compilation

- Construction TypeScript/Vite réussie.
- 25 tests serveur : rôles, sièges, invitations, expiration, révocation, séparation des entreprises et profil filtré.
- 10 tests natifs des comptes, dont création d’un espace vide depuis le profil partagé et refus de remplacer un espace existant.
- Gestes et lecteur sur Chromium/Edge : 320 × 568, 390 × 844 et 844 × 390, avec simulation des zones sûres ; saisie tactile via CDP pour le menu, événements tactiles à deux doigts pour le zoom.
- Mode sombre : choix conservé, retour au clair, changements système, écrans de gestion à 390 et 1440 pixels, documents blancs et règles sombres exclues de l’impression.
- Supabase : table zentra_company_profiles créée avec RLS, accès serveur confirmé, accès anonyme refusé. Clé serveur protégée dans Sites, révision d’environnement 25 appliquée.
- WebKit sur le Mac de compilation : gestes, zoom, zones réservées, renouvellement du code et invitations réussis aux trois dimensions. Les gestes WebKit sont simulés par événements DOM ; le chemin tactile Chromium est aussi testé par CDP. Aucun essai sur iPhone physique.
- 1 530 tests d’interface réussis. Six parcours de paie en mode sombre réussis à 320 et 1 440 pixels : assureur absent, création de cotisation et choix parmi des contrats existants, sans doublon ni perte du salaire.

Les simulations ne remplacent pas un essai sur iPhone physique. La version Mac reste distribuée avec signature ad hoc tant que l’adhésion Apple Developer n’est pas active.

## Windows publié

Source applicative : `5e280c94f90512638eade1262f82813f2219f44c`. Six démarrages isolés réussis, dont remplacement de la version 1.61.0 et redémarrage avec données synthétiques : intégrité SQLite, clés étrangères, pièces jointes et identité protégée conservées. Le profil du propriétaire n’a pas été utilisé. Ces contrôles exécutent le binaire empaqueté, pas l’installateur NSIS.

Installateur : `Zentra_1.64.0_x64-setup.exe`, 23 445 158 octets, SHA-256 `A5CC7D9548F01B2ED5E89BBAB02F64D5570BA2405660C53D428C1E88F6266155`. Signature de mise à jour Tauri/Ed25519 vérifiée ; absence de certificat Authenticode conservée.

Le canal `latest-windows.json` a été promu de 1.63.1 à 1.64.0 le 14 septembre 2026 à 02:28 UTC, après comparaison des fichiers publics. Cache 60 secondes. Le manifeste partagé historique 1.46.1 reste inchangé. Preuves : `.qa/public164/public-Promote-proof.json` et `.qa/zentra-installer-packaged164-final/report.json`.

## macOS publié

Même source applicative que Windows. Build Codemagic `6aa759173f3d8fccf694cd3f` réussi. Application universelle ARM64/x86_64, identifiant `ch.zentra.desktop`, signature ad hoc vérifiée par `codesign --verify --deep --strict` sur macOS. Archive de mise à jour signée avec la clé Ed25519 existante et vérifiée indépendamment.

DMG : `Zentra_1.64.0_macos-universal.dmg`, 50 122 355 octets, SHA-256 `1FDB8A48ED2719A32A4E1B9C68DCEEA749A8D76E075CFE5BDCC494437D83377A`. Archive updater : 50 059 507 octets, SHA-256 `5F423FEDFE31CCE4450BC4A04F656B38F08410640AE0086A8F7038E565B298CE`. Canal macOS promu à 02:33 UTC après relecture publique. Aucune notarisation Apple ni installation sur un Mac physique attestée.

## Site et service d’équipe

Service d’équipe déployé par Sites 132, environnement 25. L’endpoint refuse une requête native sans session (401), et les 25 tests couvrent notamment les rôles, les places et la séparation des entreprises. La licence propriétaire iPhone est acceptée par le serveur ; la signature du jeton retourné et son identité d’installation sont vérifiées sans remplacer le jeton embarqué.

Téléchargements Windows et Mac mis à jour dans Sites 133. Sites 134, source `bcda668aff8a8c84eebdfa4c92bfe2ec83647090`, a ensuite publié les précisions sur les coordonnées partagées et les fichiers des projets. Déploiement `appgdep_6aa75e458a308191a1bff1c1f64fe649` réussi à 02:39 UTC, environnement 25. Quatre tests de téléchargement et constructions du site réussis. Le paquet iPhone personnel reste exclu des téléchargements publics.

## IPA iPhone personnel livré

Build Codemagic `6aa759184951446212053f5c`, source `47d1877336ac0171bcfc9df1ed2c2fbd8892a0a6`. Les trois tests UIKit de navigation, actions répétées, clavier, apparence et contraste sont réussis. IPA ARM64 iPhoneOS, `ch.zentra.mobile`, iOS 15 minimum. Licence propriétaire attendue présente dans le binaire, signature vérifiée et validité jusqu’au 31 décembre 2036, liée à l’identité iPhone du propriétaire.

Fichier privé livré : `Zentra-1.64.0-iPhone-PERSONNEL.ipa`, 24 945 017 octets, SHA-256 `A4E297F01F943C54DF1579B267C255DFB455B15B7801005E45BA604958C4F696`. L’installation nécessite une signature Sideloadly/AltStore. Aucun lancement sur iPhone physique n’est attesté. La licence Zentra ne remplace pas la signature Apple.

Références : [Apple — Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures), [WebKit — Designing Websites for iPhone X](https://webkit.org/blog/7929/designing-websites-for-iphone-x/).
