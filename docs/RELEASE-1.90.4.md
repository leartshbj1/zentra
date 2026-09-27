# Zentra 1.90.4 — livraison vérifiée

Cette version rassemble les correctifs natifs postérieurs à 1.90.3 : remboursements après changement de droits, taille du texte, ouverture de l’entreprise, rapports PDF, détail des chiffres de l’accueil, recherche dans les réglages, navigation mobile, chargement de la langue choisie, pagination des grandes listes et personnalisation/import sur téléphone.

Le 27 septembre 2026 : 1 749 tests frontend dans 218 fichiers et la compilation web complète passent sur la source préparée. Les recettes ciblées et leurs limites restent dans `AUDIT-PREMIER-CLIENT-SUIVI.md`. La compilation conserve un avertissement de poids de certains modules ; ce n’est pas une mesure de vitesse native.

La branche `codex/first-client-release-1904` déclenche une seule préparation Windows, Apple et Android. Les fichiers ne doivent être signés puis publiés qu’après vérification de la source exacte, des empreintes et des contrôles du paquet. Les versions, les notes de mise à jour et le verrou Rust sont alignés sur 1.90.4.

Statut initial : aucune publication de 1.90.4. Cette version n’annonce pas le rétablissement du compte distant, des quotas Supabase, du planificateur autonome ni des signatures de distribution des plateformes. Les preuves de livraison et les limites de chaque fichier seront ajoutées après compilation dans `outputs/release1904`.

Source gelée : `c07b1d4d3031659da6ba21388a70c464a6f83ec8`. CircleCI 137 Apple, 138 Windows et 139 Android sont en cours le 27 septembre à 12 h 38, heure suisse. `build:web` régénère deux sélecteurs de `dark.generated.css` depuis le CSS source ; les couleurs ne changent pas. Quatre parcours document/import à texte 200 % repassent après cette génération, avec deux captures sombres relues. Le fichier généré est ensuite enregistré pour maintenir la source de travail propre, sans modifier la branche de compilation ni déclencher un second build.


## Publication du 27 septembre, 13 h 26, heure suisse

Les douze fichiers de [v1.90.4](https://github.com/leartshbj1/zentra/releases/tag/v1.90.4) sont publiés sur la source commune `c07b1d4d3031659da6ba21388a70c464a6f83ec8`. Les quatre téléchargements principaux répondent HTTP 200 et leur taille correspond aux fichiers vérifiés. Site 284, source `c398622042425cdf084ade130d52686ff1c1221d`, déploiement `appgdep_6ab8fd4269fc81918f9e5f655deea97d` réussi : la page de téléchargement utilise ces liens immuables et les nouvelles empreintes. Le contrat des téléchargements (5 tests), TypeScript et la compilation du site passent. Le manifeste historique et les canaux Supabase restent inchangés.

Windows 138 : paquet x64 et logo vérifiés, empreinte de l’installateur `b07f2ee1076793b9a9f7b0683a9fb1e42a00ac5b5a8ca378bb955082e019ef14`. Le contrôle indépendant 140 (source du vérificateur `b6715c2581b25b459776b61c04a4c4ccfad6a704`) a installé le paquet exact, démarré et relancé l’application ; schéma 60, intégrité `ok`. Signature de mise à jour vérifiée. Sur ce PC, 1.90.4 est installée et a passé le même démarrage/relancement avec un profil distinct ; l’exécutable précédent est conservé. Aucune recette métier réelle ni signature Authenticode n’en est déduite.

Apple 137 : Mac universel arm64/x86_64, paquet et logo vérifiés, démarrage/relancement en profil isolé, schéma 60 et intégrité `ok`, signature de mise à jour vérifiée. Signature Apple ad hoc uniquement, sans notarisation. IPA arm64 iOS 15+, 26 027 955 octets, non signé et non essayé sur iPhone.

Android 139 : APK arm64 compacté sans changer les segments de code/données chargés ni les 969 autres ressources ; alignement 16 K et certificat de test persistant vérifiés. 122 307 594 octets, débogable, sans essai émulateur ou appareil physique.

Preuves : `outputs/release1904/{SOURCES.json,github-published-proof.json,public-head-proof.json}`, dossiers `windows`, `apple`, `smoke-windows`, `smoke-macos`, `installed-smoke` et `android-signed`. La connexion testée avec un compte fictif inexistant répond toujours 503 à 13 h 09. La publication ne lève ni cette restriction, ni les recettes réelles encore ouvertes dans l’audit.
