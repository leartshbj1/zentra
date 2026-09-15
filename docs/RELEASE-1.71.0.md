# Zentra 1.71.0

Source Windows/iPhone/Android : `31c61f440af8992f6709aaeaf7aad38e68f3b844`.
Source Mac : `7a88c26b46151e8757d93b671ac1f7eac721f3b9`. Le seul écart est l’ouverture du formulaire d’invitation dans le parcours de test WebKit ; aucun code livré différent.

## Changements

- Réunion à trois versions des modifications indépendantes de l’entreprise : référence exacte, copie locale et dernière copie serveur. Les enregistrements, pièces jointes, auteurs, suites de numéros et écritures suivent la même copie intégrée.
- Contrôle automatique toutes les trois secondes lorsque l’app est ouverte, réveil sur modification/réseau, rafraîchissement de l’accueil après réception. Les formulaires actifs restent protégés.
- La référence partagée est conservée sur l’appareil, notamment après mise à jour d’une installation encore propre. Les chemins Windows/iPhone d’un même logo ne sont plus interprétés comme des changements métier.
- Les originaux restent intacts pendant la préparation. Une sauvegarde complète précède le remplacement local ; une nouvelle modification locale invalide la préparation et relance l’échange.
- Les modifications contradictoires d’un même document, paiements concurrents, pièces jointes différentes et clôtures comptables sont signalés et conservés.
- Un doublon de paiement strictement identique peut être confirmé explicitement depuis Compte. La réunion conserve un paiement et ses écritures, les deux saisies d’origine dans l’audit, et une correspondance d’identifiants pour empêcher une ancienne requête rejouée de recréer le doublon. Aucune décision financière automatique.
- Le préfixe canonique de la chaîne d’audit est inchangé. Les événements de la branche locale, avec leurs empreintes initiales, sont conservés dans un événement de rapprochement avant leur rattachement à la chaîne.
- Compte simplifié en quatre langues et dans les deux thèmes : identité, entreprise, équipe, invitations à la demande et abonnement. Pas de bouton de synchronisation manuelle dans l’état normal.

## Validation terminée

- 720 tests Rust réussis, 3 diagnostics ignorés par défaut. Les quatre anciens tests de migration retirent uniquement les déclencheurs de partage créés par leur initialisation artificielle en schéma récent avant de reconstruire leur schéma ancien.
- Fusion réelle sur trois bases isolées : facture créée et paiement distinct, écritures et audit intègres, pièces jointes partagées, réception suivante et idempotence des requêtes de paiement.
- Simulation sur trois archives exportées explicitement fournies au diagnostic : solde commun cohérent, un seul paiement après confirmation simulée, audit vérifié et empreintes des trois originaux inchangées. Aucun fichier de profil client ni entreprise serveur modifié. Le rapprochement réel du paiement reste à confirmer par l’utilisateur.
- 48 contrôles Compte sur Chromium/WebKit, 320/390/1280 px, clair/sombre, FR/DE/IT/EN. Six parcours de confirmation/annulation du doublon ; aucune confirmation envoyée après annulation.
- Parcours automatique émission/encaissement avec bridge et planificateur de production, transport synthétique : accueil actualisé sans clic, formulaire visible conservé, recherche et formulaire caché non bloquants.
- Construction web et TypeScript réussis ; 26 tests UI ciblés. 15 tests du service de collaboration et contrat de téléchargement réussis.
- Windows : six lancements de l’exécutable livré dans des profils isolés, création et redémarrage, ancienne version 1.61.0 avec données synthétiques, remplacement par 1.71.0 et redémarrage. Documents, écritures, pièces jointes et identité protégée conservés. Aucun essai interactif de l’installateur NSIS revendiqué.
- iPhone : compilation Codemagic `6aa980adcc386a54c979ad25` réussie, contrôle ARM64/iPhoneOS/identifiant/version et archive localement revérifiés, contrôles Swift des cibles tactiles réussis.
- Android : compilation Codemagic `6aa980af8c3d64dd7da26ca8` réussie, signature persistante `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670`, alignement 16 Kio vérifié avant et après signature.

## Limites

Les transferts peuvent dépasser trois secondes selon le réseau et les documents. Les conflits réels et saisies en cours sont protégés. L’égalité des montants sur les téléphones physiques du client n’a pas été attestée ; son conflit historique attend sa confirmation financière.

Windows sans Authenticode, signature Ed25519 de mise à jour vérifiée. Mac ad hoc universel sans notarisation Apple. IPA non signé, à signer avec Sideloadly/AltStore, sans licence propriétaire incorporée. APK ARM64 de test débogable. Aucun essai physique mobile ni publication sur l’App Store ou Google Play revendiqué.

## Distribution publiée le 15 septembre 2026

Les quatre plateformes sont disponibles sur https://zentraapp.ch/download et dans la release publique https://github.com/leartshbj1/zentra/releases/tag/v1.71.0 (13 fichiers).

| Fichier | Taille en octets | SHA-256 |
| --- | ---: | --- |
| Zentra_1.71.0_x64-setup.exe | 23559648 | `A3EBBFA8FCE6F62A76A29AC4FF98AE539AED8D9D38AC233E4905C4DF615788B4` |
| Zentra-1.71.0-iPhone-unsigned.ipa | 25123834 | `5AB3D288D04A33CCEB1609F578BE913DB0BB9310A285936A436254D77645217F` |
| Zentra-1.71.0-Android-arm64-test.apk | 76136975 | `DCCA2A919BF702C5739EBAC2B57B424FF4271AC67E03C93559C6581836BCE7F3` |
| Zentra_1.71.0_macos-universal.dmg | 50467586 | `24FA2B9B02D832C5E677387CE60E017967F4E7B69D9C7A2734B1D254C3C5E9FF` |
| Zentra_1.71.0_macos-universal.app.tar.gz | 50445243 | `795386C346951EEEDBBDA6C1EA0596EB28A1D02476BD9EA7F9C3CBF5B797F9E7` |

Windows, IPA et les deux fichiers Mac ont été téléchargés intégralement depuis le stockage public Supabase et comparés aux empreintes locales. Les signatures Ed25519 des mises à jour Windows et Mac ont été revérifiées indépendamment. Les canaux `latest-windows.json` et `latest-macos.json` ont été relus sans paramètre de contournement du cache et indiquent 1.71.0 ; cache 60 secondes. Le canal historique `latest.json` est conservé en 1.46.1.

L’APK dépasse la limite de taille du bucket Supabase et est distribué sur GitHub. Son état public, sa taille et son empreinte intégrale fournie par l’API GitHub correspondent au fichier signé local. Un téléchargement anonyme a reçu 7 533 553 octets, comparés au fichier local ; plusieurs tentatives complètes, y compris par plages, ont expiré sur cette connexion. Le téléchargement anonyme intégral n’est donc pas attesté. Aucun fichier incomplet n’a été publié.

Compilation Mac `6aa986c82db1cf288272de0e` réussie, source `7a88c26b46151e8757d93b671ac1f7eac721f3b9`. Contrôles WebKit tactiles, documents, zones sûres, apparence, invitations et adhésion réussis sur la machine Apple. Bundle universel ARM64/x86_64, identifiant `ch.zentra.desktop`, version, canal et clé de mise à jour embarqués vérifiés dans l’archive téléchargée. Signature ad hoc contrôlée sur Codemagic ; aucune notarisation Apple.

Site final : version Sites 161, source exacte `905054120cf2122081598fdf4bdc3d3eef710663`, version `appgprj_6a942972adf481918671ac74e99e1fa7~appgver_2f42f0df35a48191a3fd5ad519d0ac14`, déploiement `appgdep_6aa98dfead2c8191b4d026c78fc2b11f` confirmé réussi, environnement 30. Les quatre téléchargements pointent vers 1.71.0 ; les changements d’accès personnel fondateur déjà publiés dans la version 159 sont conservés. Construction du site et quatre tests du contrat de téléchargement réussis sur cette source.

Preuves locales ignorées par Git : `.qa/public171/`, `.qa/macos171/verification.json`, `.qa/zentra-installer-packaged171-verified/report.json` et `.qa/company171-preview-final/preview-report.json`. Les copies client et l’entreprise réelle n’ont pas été modifiées ; le rapprochement du paiement historique reste soumis à une confirmation explicite.
