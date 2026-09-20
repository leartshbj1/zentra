# Zentra 1.74.0 — Un espace Automation intégré

## Fonctionnement

Le menu et la recherche de navigation présentent Zentra Automation dès que l’accès de l’entreprise est reconnu, même si ses suggestions restent à configurer. L’espace réunit **Vue d’ensemble**, **Outils** et **Réglages**. Le tableau de bord et les outils contextuels permettent d’y revenir directement.

Les réglages conseillés préparent un brouillon avec les fonctions disponibles, le mode suggestion et des seuils de 75 % / 95 %. Ils ne donnent pas l’accord d’analyse à la place du responsable et n’enregistrent rien avant sa validation. Le titulaire et les administrateurs configurent l’entreprise ; les collaborateurs conservent les droits de leur rôle.

Les outils ouvrent les vrais écrans et formulaires de gestion. Une suggestion confirmée ne constitue pas un paiement ou une écriture automatique. Un guide propre à Automation explique ces limites et le parcours.

L’accès se rafraîchit en arrière-plan toutes les 15 secondes et au retour au premier plan. Une panne ne fait pas disparaître un menu déjà reconnu, mais retire l’état utilisable pour les actions. Aucun état n’est réutilisé entre entreprises. Les mises à jour reçues pendant une requête sont rejouées après celle-ci. Un changement distant de consentement n’est plus confondu avec une saisie locale.

## Validation de l’interface

- 1 575 tests réussis dans 190 fichiers, dont activation, révocation, changement d’entreprise, réponses tardives, indisponibilité, reprise et droits des rôles.
- Construction TypeScript et Vite réussie ; avertissements de taille de blocs préexistants.
- 72 vérifications des trois rubriques : 320, 390 et 1 280 px, français / allemand / italien / anglais, clair / sombre. Aucun débordement horizontal détecté.
- Parcours sur données fictives dans le vrai composant WorkspaceApp : menu mobile, configuration conseillée, accord explicite, enregistrement, analyse puis ouverture du formulaire de devis.
- Collaborateur en lecture seule et retour automatique après indisponibilité vérifiés dans le navigateur.
- 84 tests serveur Automation réussis sur le site : accès partagé des cinq rôles, isolation des entreprises, révocation, réglages, décisions et facturation.

## Distribution

Source de tous les paquets : `c38aec63c24dd04abff434d57b881a4d5333afee`.

### Windows

- Compilation locale finale, signature de mise à jour Ed25519 et provenance vérifiées.
- Six scénarios passés : démarrage et redémarrage 1.74, initialisation et données fictives en 1.72, remplacement par 1.74 puis redémarrage. Identité, empreintes des tables, factures, devis, paiements, écritures équilibrées et pièce jointe conservés.
- Le vérificateur des anciennes fixtures a été adapté aux callbacks SQLite de la version 1.72. La protection d’écriture demeure dans les déclencheurs ; la préparation hors ligne utilise des données fictives dans un profil séparé sans compte.
- Cet essai porte sur l’exécutable livré ; l’installation NSIS et le profil réel du client n’ont pas été exécutés ou modifiés.
- Installateur public : 23 661 562 octets, SHA-256 `61C34BE9E594241D6468E61E752360649FF48E39D5016745F8FFB3EE277D52F2`.
- `latest-windows.json` publié en 1.74.0, relu publiquement et vérifié avec un cache de 60 secondes. Le manifeste historique partagé reste inchangé.
- Absence de certificat Authenticode : Windows peut afficher « Éditeur inconnu ».

### Mac

- Compilation Codemagic `6aafd7150723cd85ffc14e8d` réussie ; code source et sommes de contrôle vérifiés.
- Universel ARM64 / x86_64, macOS 12 minimum. Signature Apple ad hoc et signature Ed25519 de l’archive de mise à jour vérifiées. Pas de notarisation Apple.
- Gestes WebKit, zones sûres et aperçu des documents vérifiés aux tailles 320, 390 et 844 px ; accès entreprise clair/sombre vérifié à 320, 390 et 1280 px.
- DMG public : 50 559 851 octets, SHA-256 `5DB8AFB2999BE66088B5B2E17F674E3F026EE23BD85CD53C599225CBE102277C`.
- Archive updater : SHA-256 `423EED4E5DC740A5B6EB2BD185462EBF55A54644D36CC5129AF3F5D02D9D0EE3`.
- `latest-macos.json` publié en 1.74.0, relu publiquement et vérifié avec un cache de 60 secondes.

### iPhone

- Compilation Codemagic `6aafd71665ef17622f34f0f4` réussie, ainsi que les tests Swift des boutons Liquid Glass et des zones tactiles.
- IPA ARM64 pour iPhone physique, identifiant `ch.zentra.mobile`, iOS 15 minimum. Métadonnées d’origine, source, Mach-O et somme de contrôle vérifiés avant publication.
- IPA public : 25 164 823 octets, SHA-256 `882F4B0A1D76EDE0CD042F5765FF5CF135089AE765B7EA483A093FF8F36A3BC6`.
- IPA non signé, sans profil de provisioning : nécessite une signature personnelle avant installation. Aucun essai sur iPhone physique revendiqué.

### Android

- Compilation Codemagic `6aafd7166d90705172d66dbc` réussie. Source et somme du paquet brut vérifiées avant signature locale.
- APK ARM64, identifiant `ch.zentra.mobile`, version 1.74.0 ; alignement 16 Ko vérifié avant et après signature.
- Même certificat durable que les APK précédents : SHA-256 `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670`.
- APK signé : 76 251 663 octets, SHA-256 `70CE5B2692A254523FC8C4B56D8099F4534C04AB2E999D9C51344394439EC045`.
- Téléchargement public GitHub sans authentification : HTTP 200 et empreinte intégrale identique au fichier signé.
- Version de test avec indicateur debuggable, sans essai sur appareil physique ou émulateur revendiqué ; ce n’est pas une publication Google Play.

### Publication

- Release publique `v1.74.0` sur `leartshbj1/zentra`, 12 fichiers, source `c38aec63c24dd04abff434d57b881a4d5333afee`.
- Installateurs Windows/Mac et IPA également vérifiés publiquement sur le stockage de distribution Zentra. Les deux canaux de mise à jour ordinateur pointent vers 1.74.0.
- Site : quatre tests de téléchargement, contrôle TypeScript et construction vinext réussis. Source `2a2e4a535bbd99ea322eecbcb28126e8f621ddf8` ; version 190 ; déploiement `appgdep_6aafe019abfc8191b88579782d8cade2` réussi le 20 septembre 2026 à 13:31 UTC.
- Téléchargements présentés sur `https://zentraapp.ch/download`, avec les conditions d’installation propres à chaque plateforme.

Les contrôles ci-dessus ne constituent pas une installation réussie sur un appareil mobile physique. La mise à jour du site seule n’ajoute pas ces écrans à une ancienne version de l’application.
