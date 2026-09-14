# Zentra 1.65.0 — Couleurs sombres et retour au mode clair

La palette sombre utilise des gris neutres, des textes plus contrastés et des accents verts lisibles. Les variables sont appliquées aussi à la racine de l’espace de travail. Les formulaires, menus, documents et réglages partagent ces couleurs.

Le changement de thème remet désormais à jour le fond inline défini au démarrage. Les appels natifs sont sérialisés pour que le dernier choix reste appliqué, même après plusieurs clics rapides. Le mode automatique suit à nouveau le système après effacement du stockage.

Sur iPhone, le fond du contrôleur, de la fenêtre WebKit, de la zone de défilement et du défilement élastique suit le thème. Les documents, échantillons de personnalisation et couleurs d’impression restent distincts de l’interface. Le schéma de couleur et le fond de la page sont réinitialisés lors de l’impression.

Les étapes d’ajout d’un collaborateur sont mises en forme dès la première ouverture. Le bouton Annuler ne se coupe plus à 320 pixels. Les étapes de configuration disponibles restent lisibles en sombre. Les nouveautés sont documentées dans l’application en français, allemand, italien et anglais.

## Contrôles

- Construction TypeScript/Vite réussie et 1 535 tests d’interface réussis dans 184 fichiers.
- Edge : 138 écrans et états à 320, 390 et 1 440 pixels, 101 165 éléments dont les couleurs et pseudo-éléments reviennent à leur état clair initial. Aucun contraste de texte insuffisant détecté dans les éléments contrôlés.
- Configuration initiale : 64 états, les quatre langues à 320 et 1 440 pixels, 12 168 éléments restaurés, sans contraste de texte insuffisant détecté ni débordement horizontal.
- WebKit sur macOS : les mêmes 138 états, 101 183 éléments restaurés. Gestes, zoom des documents et zones sûres également vérifiés.
- Six parcours de paie en sombre à 320 et 1 440 pixels : assureur absent, nouvelle cotisation et contrats déjà présents ; fiches enregistrées sans doublon ni perte du salaire saisi.
- Quatre tests UIKit du changement de thème et des cibles tactiles Liquid Glass réussis sur simulateur iOS 26.

Les contrôles de contraste couvrent le texte visible des scénarios, avec exclusion des contrôles désactivés et des couleurs personnalisées des documents. Ils ne constituent pas une certification exhaustive d’accessibilité.

Le premier test UIKit comparait l’identité des UIColor ; WebKit renvoie une UIColor adossée à un CGColor, numériquement identique mais non égale à l’objet sRGB attribué. Le test corrigé compare les composantes RGBA, avec une tolérance de 0,0001. Le code applicatif est inchangé par cette correction du test.

## Publication Windows

Source applicative : `ad89ab52a567682d23800a1ec2b0eee8b317a0bd`. Installateur `Zentra_1.65.0_x64-setup.exe`, 23 476 379 octets, SHA-256 `6195464CACE0E165FB6341D1BEE7742A83531640DFCCCC038E49363C788E76E5`. Signature de mise à jour Tauri/Ed25519 vérifiée indépendamment. Absence de certificat Authenticode conservée.

Canal `latest-windows.json` promu le 14 septembre 2026 à 12:33 UTC, fichiers publics relus et comparés, cache 60 secondes. Le manifeste partagé historique 1.46.1 reste inchangé. Le moteur natif Windows et les migrations sont identiques à ceux de 1.64.0 ; les nouveaux écrans sont testés dans Edge. Zentra restant ouverte sur le poste, les démarrages du binaire 1.65.0 avec un profil isolé n’ont pas été relancés. Aucune installation NSIS ni manipulation des données du propriétaire n’est attestée dans cette recette.

## Publication macOS

Build Codemagic `6aa7e44a71a77140c239f1bb` réussi, même source applicative que Windows. Application universelle ARM64/x86_64, identifiant `ch.zentra.desktop`. Signature ad hoc vérifiée par codesign sur macOS ; archive updater signée avec la clé Ed25519 existante puis vérifiée indépendamment.

DMG `Zentra_1.65.0_macos-universal.dmg`, 50 124 861 octets, SHA-256 `2FDD490DCC2A7C6D31ED7EB684AEC0E55292D987FCC9B3CB09136AAF7A3A8878`. Canal `latest-macos.json` promu à 12:32 UTC après relecture publique. Version non notariée par Apple, sans essai sur un Mac physique du propriétaire.

## IPA personnel

IPA `Zentra-1.65.0-iPhone-PERSONNEL.ipa`, 24 946 751 octets, SHA-256 `C62569B1AA108B54DF09E92FB8CECF9016F0B40E6A1AC663E8D11D87DE736E55`. ARM64/iPhoneOS, identifiant `ch.zentra.mobile`, iOS 15 minimum. Licence propriétaire intégrée vérifiée, liée à l’identité attendue ; le serveur accepte la licence et la réponse signée a été contrôlée. Le fichier personnel n’est pas publié comme téléchargement client.

Compilation privée `6aa7e44b8e834d83ab4b3d6d`, source `41c559ab314dc48bfde3fd2210e406c8e9e6e243`. Cette exécution a compilé l’IPA mais son ancien test d’égalité UIColor a échoué. Vérification native corrigée réussie séparément : `6aa7ecac8a4e36e8618b85a4`, source `34dceec45a5e4b7352f784e849e93bed62025fbd`. Les fichiers Swift applicatifs des deux sources sont identiques. Le paquet IPA n’a donc pas été recompilé pour ce changement de test.

Fichier livré dans Téléchargements. Une signature avec Sideloadly ou AltStore reste nécessaire. Aucun lancement sur iPhone physique n’est attesté ; la licence Zentra ne remplace pas la signature Apple.

## IPA public et site

Build public Codemagic `6aa7ecacd50368aa85466260` entièrement réussi, source `34dceec45a5e4b7352f784e849e93bed62025fbd`. Cette source diffère de celle des binaires Windows/Mac uniquement par le test de comparaison des couleurs et son workflow isolé. Les quatre tests UIKit passent aussi dans la compilation publique.

IPA `Zentra-1.65.0-iPhone-unsigned.ipa`, 24,942,251 octets, SHA-256 `E0BAC414712E8FA476210CBEF8BD5E941CB2762A5EBD9CE46570CFC382B98EC3`. Architecture ARM64/iPhoneOS, absence vérifiée de la licence propriétaire. Fichier et empreinte publiés dans le stockage public Supabase puis téléchargés et comparés. Une signature Sideloadly/AltStore reste nécessaire ; aucune publication App Store/TestFlight.

Le site public est publié avec Sites 136, source `72e447e947ae4bf938fbe76fe8e4b5ec53d4c2f5`. Déploiement `appgdep_6aa7efb49a7881919f7f190092ba81b5` réussi le 14 septembre 2026 à 12:59:48 UTC, environnement 26 conservé. Quatre tests des téléchargements et construction du site réussis. Les liens distinguent Windows/Mac/iPhone 1.65.0 des archives Android et simulateur iOS 1.46.1. Le fichier personnel est exclu du site public.

Preuves locales : `.qa/release165-evidence.json`, `.qa/public165/public-Promote-proof.json`, `.qa/macos165/public/public-Promote-proof.json`, `.qa/iphone165/public/public-proof.json` et rapports de compilation Codemagic. Les fichiers d’authentification temporaires utilisés pour publier sont supprimés à la fin de l’opération ; les clés de signature existantes et la licence personnelle originale sont conservées.
