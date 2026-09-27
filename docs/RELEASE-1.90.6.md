# Zentra 1.90.6

**Correctif découvert avant publication, 22 h 06 :** l’IPA du build 152 est rejeté : ses deux icônes compilées sont celles de Tauri. Les bons PNG étaient dans le dépôt mais n’étaient pas copiés dans le catalogue Xcode après `tauri ios init`. Le commit **`805cc9b0c1ad6ff75581eee7296d3a842bfa6b27`** corrige cette étape et fait refuser une IPA dont les pixels compilés diffèrent des icônes Zentra. Cinq tests passent, dont les cinq filtres PNG et la conversion Apple CgBI. Le build **153 iPhone** est en cours. Les validations antérieures de taille/architecture iPhone ci-dessous ne rendent donc pas le paquet 152 publiable.

**Windows 150 et contrôle d’installation 154 réussis.** Installateur 24 536 107 octets, SHA-256 `d9f5d5b7cdbeb9d1bc0ed1fc2a34d2531348126cfe63b73dd64293d729ccc0cd`. Signature updater et icônes du paquet vérifiées. Aucun remplacement local ni publication encore réalisés. La source applicative `9ec8e782` reste gelée ; le correctif iPhone ne change que les scripts de fabrication, leur vérification et la documentation. La livraison devra consigner séparément la provenance de l’IPA corrigée.

- Personnalisation des documents et outils de texte en français, allemand, italien et anglais. Recherche directe du réglage, valeurs et textes du client conservés.
- Bouton de retour de l’atelier accessible pendant le défilement ; choix du format adaptés au texte agrandi sur mobile. Nom des polices Inter et Literata corrigé dans les modèles.
- Rendez-vous reçus visibles dans le journal Automation, avec ouverture du jour exact. Dates invalides et éléments absents de l’appareil signalés.
- Détails Automation et indications de correction plus lisibles et traduits.

Cette version ne rétablit pas à elle seule le service de comptes restreint par ses quotas ni le traitement automatique lorsque les applications sont fermées. Ces incidents sont suivis séparément.

Source gelée : **`9ec8e782a160e7fe2cdf3b853e19e54bbfa64a01`**, branche `codex/first-client-release-1906`. Au 27 septembre à 21 h 48 (Europe/Zurich), les exécutions **151 Android et 152 Apple réussissent** ; **150 Windows reste en cours**. Les paquets Android, Mac et iPhone sont vérifiés. Aucune publication 1.90.6 ni promotion des canaux n’a encore eu lieu.

## Vérifications déjà obtenues

- **Mac universel** : build 152, démarrage et relancement réels dans un profil isolé, SQLite 60 intègre, arm64 et x86_64, clé et endpoint updater vérifiés. Signature ad hoc vérifiée sur Mac ; signature updater contrôlée après téléchargement. DMG 54 742 957 octets ; archive 53 552 349 octets, identique à celle testée. Aucune notarisation.
- **iPhone** : build 152, IPA 26 126 952 octets, arm64 iPhoneOS 15+, version/source/empreinte vérifiées. Non signé ; aucun appareil physique.
- **Android** : build 151, APK final 122 885 130 octets, certificat de test persistant et alignement 16 K vérifiés. La suppression des symboles préserve les segments exécutables/données et les 969 ressources. Encore débogable ; aucun appareil/émulateur.
- **Documents sur Mac** : 21 tests du moteur de composition PDF et 61 tests frontend de l’éditeur passent. Les rapports WebKit incluent 150 contrôles d’apparence, les gestes sur trois dimensions et des scénarios de compte fictifs ; ils ne prouvent pas une connexion réelle.
- **Mesure Windows avant mise à jour** : 42 navigations natives, 14 écrans × 3 passages, version 1.90.5, petite entreprise fictive. Médiane 45 ms, p95 345 ms, maximum 362 ms, aucune erreur JavaScript ni longue tâche détectée. Ce n’est pas une mesure de charge serveur ni une validation de 150 entreprises.
- **Compte au contrôle de 21 h 43** : connexion avec une adresse fictive inexistante renvoyant HTTP 503 en 3 753 ms, `Retry-After: 60`, `no-store`. Aucun compte/e-mail créé. Le blocage reste ouvert.

Preuves locales : `outputs/release1906/{apple,android,android-signed,smoke-macos}/`, `upgrade-smoke/navigation-1.90.5.json`, `auth-readiness.json`. Le profil local réel de l’utilisateur reste séparé des essais.

La dernière suite frontend compte 1 814 tests réussis ; les recettes des lots figurent dans `AUTOMATION-DETAILS-20260927.md`, `AUTOMATION-RENDEZ-VOUS-20260927.md`, `DOCUMENT-NAVIGATION-LANGUES-20260927.md` et `DOCUMENT-EDITOR-LANGUES-20260927.md`. Les 14 contrats de livraison, TypeScript, build Vite et 50 actifs de marque passent avant gel. Les chaînes Windows et Apple vérifient aussi le moteur de composition PDF et les tests frontend de l’éditeur. Les preuves navigateur utilisent des données fictives et ne valent pas validation d’un appareil physique ou du service en production.

Distribution prévue selon les configurations existantes : Windows sans Authenticode ; Mac universel signé ad hoc, sans notarisation ; IPA non signé ; APK Android arm64 de test, débogable. Les paquets de mise à jour seront signés seulement après vérification. Aucun dépôt en boutique n’est annoncé.
