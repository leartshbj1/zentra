# Zentra 1.35 — dossiers acompte et solde

Version publiée et vérifiée le 6 septembre 2026 (Europe/Zurich) : canal de mise à jour Windows/macOS, [téléchargement](https://elyko.alb-leart1.chatgpt.site/download) et [douze fichiers GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.35.0). Le lot 1.34 reste non publié après deux blocages Android au contrôle final.

La conversion d’un devis accepté avec acompte crée maintenant deux factures brouillons dans une seule transaction : l’acompte et le solde. Le solde reprend les lignes exactes du devis et déduit les lignes exactes de l’acompte, avec leurs arrondis de TVA. Les deux factures restent accessibles depuis un dossier commun dans Devis, Factures et le projet. Les anciens acomptes isolés disposent d’une action explicite pour créer le solde ; la migration ne crée aucune facture spontanément.

Chaque facture reçoit son propre numéro et sa propre référence bancaire lors de l’émission. Le solde exige l’émission préalable de l’acompte et cite son numéro dans son PDF. La déduction ne crée aucun paiement fictif. Les dates et notes restent modifiables sur les brouillons, tandis que leurs montants et liens sont protégés. La correction automatique isolée d’une facture liée est bloquée ; une réduction peut être documentée par un avoir manuel sur le solde, dans la limite de celui-ci.

Un acompte à 100 % conserve une facture finale à zéro, sans QR de paiement ni écriture comptable ; ce document n’est pas signalé comme une source comptable manquante. La ventilation de TVA sur encaissements tient compte des lignes positives et des déductions lors des paiements partiels. La base passe au schéma 50 et la sauvegarde/les exports conservent les liens du dossier.

La correction du signal de démarrage natif perdu est également incluse : une sonde de disponibilité en lecture seule peut confirmer le démarrage si l’événement natif manque. Les seize contrôles du nouvel APK Android, après lancement et interruption, sont réussis.

## Vérification

- Parcours de conversion et reprise d’un ancien acompte sur 320, 390, 768 et 1440 pixels ; ouverture des deux factures, dates, émission de l’acompte, montants et absence de débordement.
- Tests natifs : deux taux de TVA et prestations exonérées, arrondis de 0,01 à 100 %, décompte convenu/reçu, paiements partiels, PDF, journal et restauration de sauvegarde.
- PDF natifs relus visuellement : acompte sur une page, solde sur deux pages avec la déduction et la référence de l’acompte.
- Suite locale complète : 538 tests natifs réussis, 1 ignoré ; 696 tests d’interface réussis. Clippy avec avertissements interdits et compilation web réussis. Les huit parcours vérifient aussi l’accès depuis le projet et les boutons tactiles.
- Windows : paquet signé pour le système de mise à jour, accueil et rechargements, fermeture et réouverture avec identité inchangée, puis interrogation réelle du canal public 1.35.0.
- macOS : 539 tests natifs réussis, un ignoré ; archive universelle Intel/Apple Silicon, démarrage réel, schéma 50 intègre et signature de mise à jour vérifiés. [Contrôle macOS](https://github.com/leartshbj1/zentra/actions/runs/33997431288).
- Android : [seize ouvertures du même APK signé](https://github.com/leartshbj1/zentra/actions/runs/33998495600), identité conservée et schéma 50 intègre. [Mise à jour des APK exacts](https://github.com/leartshbj1/zentra/actions/runs/33998749950) de 1.33 vers 1.35 avec client, projet et fichier conservés. L’ancien écran 1.33 avait bloqué avant l’installation du nouvel APK dans un premier contrôle ; la vérification de migration part donc d’une ancienne base réellement initialisée sans exiger l’interface ancienne. Un défaut de préparation du test, qui confondait présence du fichier et schéma prêt, a également été corrigé et son échec conservé.
- iOS : [démarrage, redémarrage de l’application et du simulateur](https://github.com/leartshbj1/zentra/actions/runs/33998218793), identité conservée et schéma 50 intègre. Les trois captures ont été relues.
- Les douze fichiers du canal public et les douze fichiers GitHub correspondent aux empreintes locales. Site version 55, source `b53ebee973d7209ccf47559d8c83cd612a17653f`, contrôlé sur 320, 390, 768 et 1440 pixels. Source native : `a3af2fd78cc367abd1b670d11312d3b9d38f264e`. Preuve consolidée locale : `.qa/release-1.35-verified.json`.

## Limites de distribution

Android reste un APK ARM64 de test ; iOS reste une archive pour simulateur ARM64, non installable directement sur iPhone. Aucune publication App Store/Google Play, validation sur téléphone physique, mise à jour mobile automatique ou synchronisation des données entre appareils n’est annoncée. Les signatures de mise à jour ne remplacent pas Authenticode ni la notarisation Apple. Le contrôle Windows du canal public ne prouve pas un remplacement complet par l’installateur, et le contrôle macOS ne constitue pas une recette interactive de son interface. L’audit général de l’application continue.
