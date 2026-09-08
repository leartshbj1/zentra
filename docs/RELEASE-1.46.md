# Zentra 1.46.1 - préparation de distribution

La candidate 1.46.0 a été rejetée : les essais réels Windows et Android ont révélé un refus de migration depuis le schéma 58 de la version 1.45.0. Son installation neuve fonctionnait, mais la liste des anciennes versions acceptées par le démarrage natif s'arrêtait à 57. Les compilations macOS correspondantes ont été arrêtées et la release GitHub reste en brouillon avec l'avertissement de ne pas l'installer. Les trois fichiers Windows immuables déposés pour ces essais ne sont pas référencés par le manifeste stable.

La correction est préparée en 1.46.1, avec un test de régression qui reproduit le refus via le véritable démarrage de LocalStore avant de vérifier la conservation des devis, factures, paiements, séquences et d'un document, puis un second démarrage. Les liens et le manifeste publics restent sur la version 1.45.0 jusqu'à vérification des nouveaux artefacts.

## Changements à livrer

- Sauvegarde complète de l'entreprise dans le coffre distant, sur demande ou chaque jour lorsque l'application est ouverte et l'option activée.
- Reprise d'un envoi interrompu, restauration dans une installation neuve et contrôle des empreintes, de la base, des écritures comptables et du journal d'audit.
- Récupération web des sauvegardes pour le titulaire et les administrateurs, y compris après résiliation ; restauration locale sans réactiver un abonnement.
- Correction du transfert des fichiers de projet et de l'accès aux fiches de salaire importées après restauration sur un autre appareil.
- Nettoyage d'une session cloud dont l'échange de licence était resté inachevé.

Le schéma local passe à 59. La préparation de la numérotation partagée est incluse, mais son initialisation et la réplication métier complète restent inactives ; aucune activation automatique n'est annoncée.

## Contrôles des paquets 1.46.1

- Source native commune : `b83aa865a47b05ad578e21709186b6925ca8a09f`, schéma 59. Les modifications ultérieures concernent les audits de distribution, la documentation et le site, sans changement du code des applications.
- 742 tests d'interface et 647 tests natifs réussis sur le build Mac, deux tests ignorés explicitement ; analyse Clippy complète sans avertissement sur Mac et Windows.
- Treize tests natifs de numérotation et migration réussis sur 1.46.1, dont demandes concurrentes, restauration, rejeu, planification des années et démarrage avec une base issue de 1.45.0. Le nouveau test échouait avant correction avec le même message que les installateurs.
- Recette HTTPS réelle de sauvegarde et restauration de 9,5 Mo, avec deux profils Windows indépendants et nettoyage des données fictives. Cette recette a été exécutée avant la seule intégration du planificateur de numéros, sans liaison partagée active.

- Windows, workflow `34175867747` : exécution de l'installateur exact, installation neuve, remplacement de 1.45.0 et redémarrage. Base, numéros, liens devis/facture/paiement, écritures équilibrées, identité DPAPI et pièce jointe conservés sur des machines de test isolées.
- macOS, build `34175265759` : archive et DMG universels Intel/ARM64, signature ad hoc vérifiée, clé et adresse de mise à jour embarquées, démarrage réel avec un profil neuf.
- Android, workflow de mise à jour `34176084310` : paquet x86_64 compagnon exact de 1.45.0 vers 1.46.1, sans signer à nouveau l'ancien paquet, identité et données conservées. L'APK ARM64 distribué porte le certificat de préversion persistant ; son installation sur téléphone physique reste à vérifier.
- iPhone, build `34175268734` : IPA ARM64 pour appareil physique, version et structure contrôlées, non signé. Le simulateur du build `34175267253` démarre ; cet essai ne vaut pas installation de l'IPA sur iPhone.
- Signatures de mise à jour Tauri/Ed25519 Windows et Mac vérifiées sur les octets finaux. Les dix fichiers immuables du coffre public et les seize fichiers du brouillon GitHub correspondent aux empreintes locales.

## Autorisation du Trousseau Mac

Le premier essai de remplacement exact (`34177808183`) s'arrêtait avant la migration. Le diagnostic `34178017674` montre l'attente dans `SecKeychainFindGenericPassword` et une fenêtre macOS avec les boutons « Always Allow », « Deny », « Allow ». L'identité de l'ancienne installation est protégée par le Trousseau ; le nouveau paquet ad hoc doit obtenir l'autorisation normale de macOS. Aucune suppression de l'identité, modification des contrôles d'accès ou nouvelle signature des paquets de test n'est employée.

Le comportement concorde avec la documentation Apple : l'identité d'une signature ad hoc est propre à la version exacte du code, contrairement à une distribution avec identité de signature stable. Voir [TN3127, exigences de signature](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/). La signature Developer ID et la notarisation restent à obtenir.

La recette `34178563068` passe sur les deux archives exactes : base 58 vers 59, données métier, numéros, journaux équilibrés, pièce jointe et identité protégée conservés, puis redémarrage réussi. Elle utilise un Trousseau de test isolé et son propre mot de passe éphémère pour accepter la fenêtre normale macOS. Les contrôles d'accès restent actifs, aucune ACL n'est remplacée, et le Trousseau de test est supprimé après l'essai. Cet essai prouve le parcours avec autorisation explicite ; il ne prouve pas une mise à jour Mac sans intervention. L'aide de téléchargement explique cette autorisation.

## À vérifier avant annonce de publication

- Source exacte de chaque lot, versions et identifiants de paquet, signatures de mise à jour, SHA-256 et disponibilité publique des fichiers immuables.
- Remplacement exact macOS terminé, avec autorisation normale du Trousseau, conservation des données et redémarrage. La signature Developer ID et la notarisation restent distinctes de cette preuve.
- Téléchargements et manifeste commun Windows/macOS publiés seulement après ces contrôles. Les comptes Apple/Google de distribution et les essais sur appareils physiques restent des critères distincts.
