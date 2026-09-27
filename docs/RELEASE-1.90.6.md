# Zentra 1.90.6 — publiée le 27 septembre 2026

Les douze actifs sont publics sur [GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.90.6) et proposés par Sites 292. État détaillé, preuves et limitations : [ETAT-LIVRAISON.md](ETAT-LIVRAISON.md).

- Personnalisation des documents et texte riche en français, allemand, italien et anglais ; valeurs et textes du client conservés.
- Retour de l’atelier accessible pendant le défilement, format adapté au texte agrandi sur mobile, noms des polices Inter et Literata corrigés.
- Rendez-vous reçus dans le journal Automation avec ouverture du jour exact ; dates invalides et données absentes explicites.
- Détails Automation et indications de correction plus lisibles et traduits.
- Icône iPhone/iPad corrigée dans la fabrication Xcode et contrôlée sur les pixels du paquet compilé. L’IPA initiale du build 152 a été rejetée avant publication ; seule celle du build 153 est diffusée.

## Sources et tests

Source applicative gelée `9ec8e782a160e7fe2cdf3b853e19e54bbfa64a01` pour Windows 150, Mac 152 et Android 151. Source iPhone 153 `805cc9b0c1ad6ff75581eee7296d3a842bfa6b27`, cible du tag : les sept différences ne concernent que fabrication, vérification et documentation. Le code applicatif et les actifs de base sont identiques. La recette Windows 154 utilise les fichiers exacts du build 150, avec son vérificateur séparé `ab663c6f6a1a019b6953a77f3cc7ac68ea7bb008`.

1 814 tests frontend au dernier lot ; 14 contrats de livraison, TypeScript, build Vite et 50 actifs de marque avant gel. Apple : 21 tests de composition PDF et 61 tests frontend de l’éditeur. Windows et Mac : démarrage et relancement de l’installation dans un profil cloud isolé. Signatures updater, empreintes des douze actifs et quatre liens publics vérifiés.

Le vrai bouton de mise à jour Windows trouve 1.90.6 en 2 373 ms et télécharge le fichier, mais **l’installation locale échoue** : Code Integrity 3033/3077, erreur 4551. Le PC reste en **1.90.5**, exécutable inchangé. Aucune protection modifiée. Les 110 tables, trois fichiers et montants du profil fictif sont inchangés après le refus et sa fermeture.

Huit exemples PDF, 14 pages, ont été exportés puis contrôlés depuis la version **1.90.5 encore installée**. Logos, polices embarquées, montants et formats passent ; le bilan paysage conserve un titre de section orphelin à améliorer. Les sources Rust PDF sont inchangées dans 1.90.6 ; aucune recette native locale 1.90.6 n’est revendiquée.

## Limites toujours ouvertes

Cette version ne rétablit pas les quotas du service de comptes ni le traitement quand les apps sont fermées. Connexion synthétique encore HTTP 503 à 21 h 43. La collaboration réelle, les paiements et les quotas nécessitent leur recette après rétablissement.

Windows sans Authenticode ; Mac signé ad hoc, non notarisé ; IPA non signé ; APK Android arm64 de test, débogable. Pas de publication en boutique ni de test sur iPhone/Android physique. Les signatures updater ne sont pas des signatures de distribution du système. Les anciens manifestes Supabase restent inchangés.
