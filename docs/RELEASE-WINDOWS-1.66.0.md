# Zentra 1.66.0 — remise à zéro et récupération de l’entreprise invitée

## Parcours

Dans Paramètres → Sauvegardes et mises à jour, **Réinitialiser cette application** demande d’écrire `REINITIALISER`. Une sauvegarde complète est créée avant de remplacer la base et ses pièces jointes. La session de compte, les exports internes, les transferts de sauvegarde en attente, les brouillons et les caches WebView sont retirés. L’identité d’installation, la licence locale et les sauvegardes de sécurité restent présentes. Aucun appel ne supprime de données de l’entreprise en ligne. Les fichiers exportés hors de l’app ne sont pas effacés.

Le premier écran propose **Retrouver mon entreprise précédente**, y compris sur mobile, sans demander de parcourir un dossier privé du système. Cette récupération exige encore un espace vide, déconnecte le compte cloud et conserve les limites de la licence de l’appareil. Le marqueur local ne peut pas désigner un fichier extérieur au dossier des sauvegardes.

Dans Compte et équipe, le titulaire ou un administrateur confirme le partage complet, comprenant explicitement la comptabilité et les salaires. Une archive complète est envoyée par fragments vérifiés, puis publiée pour l’équipe. Le lien d’invitation conserve les contrôles d’adresse e-mail, de rôle et de places du plan. Après acceptation du lien et connexion de l’appareil depuis **Rejoindre une entreprise**, la copie complète est reçue automatiquement. Une entreprise existante ou même des données présentes avant la fin de la configuration ne sont jamais remplacées par ce parcours.

## Portée exacte

La copie initialise l’appareil invité ; elle ne fusionne pas les modifications métier ultérieures. Les fichiers des projets gardent leur synchronisation existante. Cette limite est affichée avant partage et réception. L’historique privé des sauvegardes reste réservé aux titulaires et administrateurs. Tous les membres autorisés peuvent recevoir uniquement la copie explicitement partagée, même en lecture seule ; leur rôle ne change pas. Révoquer un compte bloque les lectures suivantes, sans effacement à distance des fichiers déjà reçus.

Les archives conservent les limites du service de sauvegarde (512 Mio, fragments de 8 Mio). La copie partagée ne se renouvelle pas silencieusement : le titulaire peut l’actualiser depuis Compte et équipe. Une copie supprimée ou remplacée ne permet pas de poursuivre un téléchargement périmé.

## Vérification

- Tests serveur SQLite : isolation entre entreprises, consentement strict, rôles, refus des archives incomplètes/supprimées, contrôle de chaque fragment ; 53 tests avec les invitations, places et sauvegardes existantes.
- Tests natifs sur répertoires temporaires : effacement local, identité stable, sauvegarde restaurable, refus de chemins externes et refus d’écraser un espace non vide ; validation du transfert complet et des empreintes existante.
- Tests UI : préférences et cache, historique des versions, mutations et actualisation des droits ; 167 tests ciblés.
- Parcours navigateur Chromium et WebKit : 320, 390 et 1280 px, clair/sombre, confirmation, annulation, échec récupérable, reprise après coupure, arrivée automatique et retour au démarrage.

Les parcours navigateur utilisent des données fictives et des appels natifs simulés. Ils ne constituent pas une installation sur iPhone réel, ni une recette de partage entre deux comptes en production. Les preuves de construction et publication Windows sont conservées séparément sous `.qa` ; aucune publication macOS/iOS n’est attestée par cette note.

## Publication vérifiée — 14 septembre 2026

Le programme publié est construit depuis `22dd5f0c3050f34d64ca1675592e541d6995e3da`. L’installateur Windows mesure 23 454 571 octets ; son SHA-256 est `65E50082D252CA5A68AD74FCD1F821602BC9CAC67B48C7D2ADCDF6E1C4E5E327`. Sa signature de mise à jour Tauri/Ed25519 a été vérifiée indépendamment ; il ne possède pas de certificat Authenticode.

Six démarrages du binaire empaqueté ont été validés dans des profils isolés : première ouverture, redémarrage, initialisation et données fictives de 1.61, remplacement par 1.66, puis redémarrage. L’intégrité SQLite, les relations, les données métier, le document joint et l’identité protégée restent valides. Le premier lancement du test a échoué parce que son tableau de versions s’arrêtait à 1.64 ; le vérificateur a été complété pour le schéma 59 inchangé, puis les six essais ont réussi. Aucune installation NSIS ni remise à zéro des données du propriétaire n’a été effectuée.

Les cinq fichiers versionnés ont été envoyés par l’interface Supabase, puis retéléchargés et comparés. Après le déploiement du serveur, l’ancien `latest-windows.json` a été conservé sous `latest-windows-before-1.66-ui-20260914.json`, puis le nouveau manifeste a été envoyé. La promotion par cette interface n’est pas atomique. L’URL normale et une URL de vérification servent bien 1.66 ; le manifeste partagé historique reste inchangé. Supabase applique ici un cache public de 3 600 secondes : la disponibilité d’une version suivante peut être différée chez un client ayant ce manifeste en cache.

Le site et la migration additive ont été publiés avec Sites 138, source `e05bcb95ce5dc8a8a5d4437aac5027695c289891`, déploiement `appgdep_6aa82c7e5bbc8191948ef3d641ca2425` réussi, environnement 27 conservé. Le navigateur affiche Windows 1.66, son lien et son empreinte sur `https://zentraapp.ch/download`. Les sondes HTTP anonymes hors navigateur ont été bloquées par la protection du site ; aucun essai de réception entre deux comptes réels n’est revendiqué. Les versions Mac/iPhone publiques restent 1.65.

Preuves : `.qa/windows166-build-delivery.log`, `.qa/windows166-stage.log`, `.qa/app-reset166-final-tests.log`, `.qa/zentra-installer-packaged166-verified/report.json`, `.qa/public166/ui-artifacts-proof.json`, `.qa/public166/ui-promotion-proof.json`, `.qa/public166/normal-channel-proof.json`.
