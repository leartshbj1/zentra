# Zentra 1.70.0

Source native exacte : `03e2572718fdca2e116c882e37541231f9159922`.

## Corrections

- Contrôle de l’entreprise toutes les 3 secondes, temps réseau compris, un seul transfert en cours. Réveil immédiat sur événement, reprise réseau et fermeture d’un formulaire ; délai de repli conservé en cas de panne.
- Les UPDATE sans changement et les contrôles de relances sans résultat métier n’incrémentent plus l’horloge de partage. Les nouvelles règles de suivi sont aussi installées sur une base déjà en schéma 60.
- Empreinte de tous les enregistrements partagés, valeurs binaires comprises, et de tous les documents joints. Seuls `updated_at`, la date de scan des relances et les opérations de scan réellement vides sont ignorés. Une ancienne installation peut récupérer sa révision de référence exacte auprès du serveur authentifié. Un faux conflit est levé uniquement si le contenu métier est identique.
- Une modification concurrente réelle ou une restauration manuelle reste protégée. Aucun écrasement automatique de facture, paiement, journal ou document.
- Les recherches et les formulaires cachés ne bloquent plus la réception. Les formulaires visibles et saisies en cours restent protégés.
- Échelle mobile fixe, sans zoom global par pincement/double toucher. Champs d’au moins 16 px pour éviter le zoom de focus iOS. Boutons et textes contraints à la largeur disponible. Le zoom des documents et le défilement à un doigt restent actifs ; le zoom bureau est rétabli hors du format mobile.

## Validation

- 8 tests Rust de collaboration : émission, paiement, égalité des soldes et journaux de trois appareils, garde d’écriture, identité des auteurs, reprise après redémarrage, faux conflits et conservation des vraies modifications.
- 25 tests UI ciblés : cadence, absence de transferts concurrents, événements réseau, changement de compte, notes de version et contrats de mise à jour.
- 16 tests serveur de partage et notifications ; 5 tests de sécurité des comptes ; 4 tests de contrat des téléchargements.
- 62 contrôles de présentation sur Chromium et WebKit : 320/390 px, paysage, FR/DE/IT/EN, modes clair/sombre et retour exact à la palette claire, gros montants, actions et aperçu des documents.
- Parcours automatisé avec bridge, planificateur et accueil de production, transport natif synthétique : émission depuis l’autre appareil puis paiement reçus sur l’accueil sans clic. Quatre combinaisons Chromium/WebKit et PC/mobile ; réception de l’émission en 2,79 à 2,94 secondes. Formulaire visible conservé, recherche et formulaire caché non bloquants.
- Pincement du document, blocage du zoom global, défilement simple, taille des champs et retour au bureau vérifiés sur Chromium et WebKit. Pas de prétention à un essai physique iPhone ou Android.
- Windows : six lancements de l’exécutable livré dans des profils isolés, création et redémarrage, ancien exécutable 1.61.0 avec données synthétiques, remplacement par 1.70.0 et redémarrage. Intégrité SQLite, clés étrangères, documents, écritures, pièces jointes et identité protégée conservés. Aucun profil client modifié ; pas de prétention à un essai interactif NSIS.
- Lecture du service réel : PC à la révision 64, serveur à la révision 66, référence 64 accessible et liée à la bonne entreprise. Aucun changement métier écrit lors du diagnostic.

## Distribution

Windows et Mac publiés ; canaux `latest-windows.json` et `latest-macos.json` confirmés en 1.70.0 sans paramètre de contournement du cache, cache 60 secondes. Canal partagé historique `latest.json` conservé en 1.46.1. Installateurs, IPA, signatures et empreintes publiés sur Supabase et téléchargés de nouveau pour vérification.

| Fichier | Taille | SHA-256 |
| --- | ---: | --- |
| Windows NSIS | 23 592 034 | `319A3E5C436C7786AE463DE2A4FC6EA75690E31206E3EBB888C83C9072F3755F` |
| iPhone IPA ARM64 | 25 057 270 | `8945CE791F2FBA02FDA50A327B476D23A8EAF3FBE171CCA23E119728ED2F36C9` |
| Android APK ARM64 de test | 75 571 727 | `A46EEA63FA41CAB2C2840CCF838C8CA7B1EE3FDA5F1F7D5CC16140ADE9890A61` |
| Mac universel DMG | 50 333 828 | `C8A8A04B7816C545A9B3F66B41C0809C1514DCF2EA8B1465B05F55F645BA0C1E` |
| Mac archive de mise à jour | 50 301 816 | `DC3284B8CC0D7B831573A975F5F9EFB12891291F9E6D05C8DDFE81224F245174` |

Compilation iPhone `6aa8add76266e98d3b766e1e` et Android `6aa8adf38f0bb5083e3b23b4` : toutes les étapes réussies, source exacte vérifiée. Certificat Android conservé : `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670`. Alignement 16 Kio vérifié avant et après signature.

Compilation Mac `6aa8adf48f0bb5083e3b23b6` : toutes les étapes réussies. Archive extraite et vérifiée localement : source exacte, empreintes, version, identifiant `ch.zentra.desktop`, deux exécutables Mach-O ARM64/x86_64, canal et clé de mise à jour embarqués. Signature Ed25519 de l’archive vérifiée indépendamment. Contrôles WebKit des gestes, documents, zones sûres, partage et apparence réussis sur la machine Apple.

Release publique GitHub `v1.70.0`, source `03e2572718fdca2e116c882e37541231f9159922`, 13 fichiers. Empreintes des cinq binaires principaux vérifiées par API publique ; APK téléchargé sans authentification et comparé au fichier signé local. Preuves : `.qa/public170/github-release-proof.json` et les preuves par fichier dans `.qa/public170/`.

Le serveur de comparaison est publié dans Sites 156, source `a072ddd5a0fabcd58d9af80d38b7ee51e319229f`. Windows et iPhone sont proposés sur la page de téléchargement dans Sites 157, source `0d7c41591a2fbabc491beb369c22fd96994f4e57`.

Publication finale des quatre plateformes : Sites 158, source `1536064a975d5cbc3befc521dbfdfe092deb6448`, déploiement `appgdep_6aa8b7640dc081919ea0fab7a7363ec3` réussi, environnement 29. `https://zentraapp.ch/download` vérifié en HTTP 200 et dans le navigateur : quatre liens 1.70.0, aucune ancienne adresse publique Elyko. Preuve `.qa/public170/site-proof.json`.

## Limites

Les contrôles à 3 secondes s’appliquent à une app ouverte et connectée. Un transfert peut durer plus longtemps selon la connexion et les pièces jointes. Les modifications réellement concurrentes ne sont pas fusionnées.

Le diagnostic réel n’a pas modifié les données du PC client. La disparition de son conflit précis devra être constatée après installation ; les essais automatisés et le contrôle de sa révision de référence ne remplacent pas ce constat.

Le tableau de bord Supabase affiche une alerte de dépassement du quota du cycle précédent, avec restriction annoncée à partir du 15 octobre 2026 si le dépassement persiste. La publication actuelle a réussi. Aucun forfait payant activé et aucun ancien fichier de publication supprimé.

IPA non signé pour installation via Sideloadly/AltStore ; aucune licence propriétaire incorporée. Android : APK de test débogable signé avec l’identité persistante. Windows : signature de mise à jour Ed25519 vérifiée, sans certificat Authenticode. Mac : distribution ad hoc, sans notarisation Apple. Aucune publication sur les boutiques Apple ou Google, aucun essai physique mobile revendiqué.
