# Confort quotidien — suivi de livraison

Objectif utilisateur : traiter les six priorités proposées et personnaliser les quatre raccourcis mobiles ainsi que les actions de l’accueil. Le bouton Menu reste accessible. Préférences propres à chaque appareil, sans modification des choix des collaborateurs.

## Contrat de conception

Mode Operate, extension de desktop/DESIGN.md. Papier clair / graphite, accent vert existant, typographie système, séparateurs fins. Les réglages présentent un aperçu puis quatre lignes réordonnables accessibles au toucher et au clavier. Aucun écran commercial, aucune nouvelle décoration. Les changements du brouillon restent dans l’aperçu jusqu’à Enregistrer ; Annuler rétablit le choix enregistré. Menu est fixe. La réduction des animations supprime les transitions. La barre native iOS conserve Liquid Glass officiel et reçoit les mêmes destinations traduites.

## Conditions de livraison

- [x] Navigation mobile et actions d’accueil personnalisables ; persistance, annulation, ordre, valeurs par défaut et quatre langues vérifiés sur Edge/WebKit, téléphone et ordinateur. Barre UIKit compilée et cinq tests natifs réussis sur simulateur ; pas de recette physique iPhone.
- [ ] Synchronisation : statut discret et exact, brouillons préservés, récupération compréhensible. Ne pas confondre essais simulés et appareils réellement connectés.
- [x] Automation : activité issue des données et accès aux rubriques de résultats (documents / rendez-vous / tâches), incertitudes distinctes du travail terminé. Essais automatisés réussis, pas de mesure client inventée.
- [x] Paie : erreurs actionnables, retour au brouillon après correction, vérification des parcours d’assurance dans le harnais.
- [ ] Distribution : builds vérifiés ; signature Windows, notarisation macOS et distribution iPhone dépendent des accès de signature réels. Ne pas présenter une IPA non signée comme installable directement.
- [ ] Pilote de cinq PME : préparer le protocole, obtenir les participants, mesurer des essais réellement effectués. Participants demandés, réponse en attente.
- [x] Revue Impeccable indépendante et documentation après vérification visuelle bornée. Verdict limité à la correction examinée, pas à toutes les plateformes natives.

Les compilations, publications, preuves et limites seront consignées ici au fur et à mesure. Aucun test de cette phase ne modifie les données métier du propriétaire.

## Preuves du 25 septembre 2026 — version candidate 1.88.0

- Interface : 207 fichiers / 1 665 tests passent. Compilation TypeScript et Vite réussie.
- Personnalisation : 8 parcours Edge/WebKit, 320/390/1440px, FR/DE/IT/EN et thèmes clair/sombre ; sauvegarde réelle des préférences locales, annulation, remise par défaut, substitution d’une case occupée, taille tactile, navigation et action Agenda. Le dernier contrôle vérifie aussi le centre du bouton Enregistrer/Annuler par hit-test, hors du dock et de l’assistant.
- Droits et aide : 4 parcours supplémentaires Edge/WebKit à 390/1440px vérifient les six actions de création désactivées en lecture seule, l’agenda accessible et le raccourci Projet qui explique le client manquant puis ouvre le formulaire adéquat. Preuve : `desktop/.qa/personalization/permissions-results.json`.
- Mouvement et clavier : le contrôle sans réduction des animations a trouvé un saut de l’aperçu après ouverture/défilement. La mesure se fait maintenant juste avant le déplacement et relativement à l’aperçu. Quatre cas Edge/WebKit avec/sans mouvement réduit passent : deux éléments animés lors d’un échange, aucun avec mouvement réduit, activation clavier et sauvegarde. Tabulation séquentielle vérifiée sur Edge ; WebKit utilise un focus explicite pour son réglage de navigation clavier. Source : `desktop/tests/personalization-keyboard-motion-journey.mjs`.
- Synchronisation : les scénarios simulés de facture et paiement actualisent le tableau de bord en 2,84–2,90 secondes sur les deux moteurs ; saisie et focus conservés, sans panneau de chargement. Le nouveau statut ne réutilise pas l’état d’une autre entreprise et vérifie la fraîcheur de la connexion. Ceci ne remplace pas la recette sur deux comptes/appareils réels.
- Paie : 12 scénarios accidents (assureur manquant, nouveau contrat, doublons) passent ; 6 scénarios de brouillon/contributions conservés passent ; 3 parcours pension 320/390/1440 passent (référence manquante, correction inline, salaire conservé, parts salarié/employeur, correction comptable et enregistrement). Le test pension historique attendait trois anciens boutons ; il vérifie maintenant les corrections directes et la reprise automatique existantes, sans assouplir les assertions sur les montants enregistrés.
- Impeccable : détecteur exécuté une fois, avertissements indicatifs de tailles/rayons ; revue indépendante puis correction du seul défaut matériel trouvé (footer sous le dock). Verdict final `ship` sur la correction évaluée. Captures et compte rendu : `outputs/daily-confidence/`; preuves fonctionnelles : `desktop/.qa/personalization/`.
- Aucun certificat de signature de code détecté dans le magasin Windows CurrentUser/My. Disponibilité des accès Apple Developer et Windows demandée ; aucune signature commerciale ni notarisation n’est revendiquée.
- Pilote : `docs/PILOTE-CINQ-PME.md` et tableau vide `docs/pilot-results.csv`. Aucun résultat client inventé ; cinq participants restent à identifier.

## Distribution du 25 septembre 2026

- Source applicative publiée : `3e9809bbe58ca16c6ede101db40d57d6f4396c80`. CircleCI 101 (Windows), 102 (Android) et 103 (Apple) ont réussi sur cette source. Les essais 98–100 portaient sur une version candidate antérieure et ne sont pas utilisés pour les paquets distribués.
- Windows 1.88.0 installé sur le PC ; binaire compilé puis binaire réellement extrait par l’installateur testés chacun au démarrage et à la réouverture dans des profils séparés. Base SQLite version 60, intégrité et clés étrangères vérifiées.
- Mac universel Intel/Apple Silicon : paquet lancé puis rouvert sur le Mac de compilation dans un profil isolé. IPA ARM64 vérifiée ; cinq tests UIKit passent, dont les raccourcis personnalisés, les cibles tactiles, le clavier et les apparences. Pas de test physique iPhone/Android.
- Android : certificat persistant vérifié ; versionCode augmente de 1087000 à 1088000 et alignement 16K valide. L’APK demeure une version de test.
- 14 fichiers publiés dans [Zentra 1.88.0](https://github.com/leartshbj1/zentra/releases/tag/v1.88.0), empreintes vérifiées ; canaux de mise à jour Windows et macOS publiés. Les signatures de mise à jour Zentra ne sont ni Authenticode Windows ni une notarisation Apple ; IPA non signée, aucune publication dans les stores.
- Page de téléchargement publiée avec les quatre paquets 1.88.0 et leurs empreintes : Sites version 262, source `61b1ac98fc3ef1e03352ea9f477445dc58a36a6f`, déploiement `appgdep_6ab5df5dbcc881919fa2e8963f6179ae` réussi le 25 septembre 2026 à 02:41:55 UTC. Domaine confirmé : https://www.zentraapp.ch. Tests des téléchargements 4/4 et build réussis. Le workflow officiel a poussé et vérifié la source, puis son lanceur de packaging a échoué sur Windows ; l’archive a été produite à partir du même build par le helper local validant le Worker, le manifeste, les migrations et l’absence de fichiers secrets.
- Le premier essai Windows avait échoué car le disque C: était plein (erreur SQLite explicite). Seuls des fichiers de compilation ont été déplacés vers `D:/Zentra-build-artifacts/release188`, avec vérification de leurs empreintes et jonctions conservant les chemins de travail. Environ 2,4 Go libérés ; le nouvel essai passe. Le journal initial est conservé dans `outputs/release188/local-smoke-disk-full`.
- Preuves : `outputs/release188/delivery-audit.json`, `smoke-windows/windows-smoke.json`, `smoke-macos/macos-smoke.json`, `public/channel-*-proof.json` et `desktop/artifacts/android/build-info.json`.
- Restant pour les six priorités : la session du compte réel sur ce PC répond 401 et demande une reconnexion ; l’essai réel entre appareils reste à faire. Accès de signature commerciale et participants du pilote attendus. Ne pas marquer l’objectif complet sur la seule base des compilations.
