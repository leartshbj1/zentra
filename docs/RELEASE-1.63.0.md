# Zentra 1.63.0

## Changements

- Navigation Apple : l'abonnement aux clics est établi une seule fois par session web. Les mises à jour de sélection et de visibilité conservent ce canal. Les boutons UIKit officiels et le dock AppKit restent utilisés sur les systèmes compatibles. Le panneau UIKit est replacé devant la vue web. Les événements reçus pendant une fenêtre bloquante ou après démontage sont ignorés ; une erreur native restitue les commandes HTML.
- Paramètres → Sauvegardes et mises à jour : « Voir les nouveautés de cette version » et « Voir les mises à jour précédentes ». Notes intégrées en français, allemand, italien et anglais, disponibles hors ligne. L'historique contient les versions documentées 1.60 à 1.63 et distingue le correctif iPhone personnel 1.62.1. Les versions futures ne sont pas présentées comme des mises à jour antérieures. Une version inconnue n'emprunte pas les notes d'une autre version.
- Factures fournisseurs : intègre les parcours de préparation, consultation, vérification et paiement précédemment validés dans les audits de qualité. Les contrôles comptables et l'interdiction des doubles écritures restent appliqués.

## Diagnostic des clics Apple

Le même objet JavaScript `Channel` était envoyé à chaque appel de configuration. Tauri 2.11 recrée alors le canal Rust avec un compteur à zéro et termine le canal remplacé. Le JavaScript supprime son callback à réception de cette fin : les boutons peuvent rester visibles sans transmettre les clics. Le test de non-régression reproduit cette situation avec la vraie classe `Channel` de Tauri. L'inscription est désormais optionnelle côté natif et fournie seulement au premier appel. Une file commune ordonne la fermeture de l'ancienne session avant la connexion suivante, y compris sous React Strict Mode.

## Vérifications réalisées

- 1 525 tests d'interface réussis, dont reproduction du défaut des canaux, clics successifs iOS/macOS, masquage, retour, déconnexion et récupération.
- 24 parcours Edge/WebKit, français/allemand/italien/anglais, largeurs 320, 390 et 1 440 : notes courantes, historique, mode mobile, hors ligne, sans installation involontaire ni débordement horizontal. Inspection visuelle du petit écran allemand.
- TypeScript et build Vite réussis. Les avertissements existants sur les gros fragments restent présents.
- 700 tests natifs réussis, aucun échec. Le contrôle HTTPS réel du renouvellement de licence passe séparément avec le moteur 1.63.0. La recette de restauration de sauvegarde HTTPS avec deux autorisations navigateur reste exclue de cette exécution.
- Trois parcours de notification de mise à jour passent à 320, 390 et 1 440 pixels : badge « 1 », ouverture du panneau, conservation hors ligne, retrait d'une version et protection de l'installation.
- Trois tests UIKit passent sur simulateur iOS 26 : coordonnées réelles dans une UIWindow, pressions répétées, clavier et contraste. Le journal du build iPhone confirme `TEST SUCCEEDED`. Ils ne constituent pas un essai sur l'iPhone physique du propriétaire.

## Distribution du 13 septembre 2026

Source des paquets publics : `87b150987dae4d3f7af9d526544d5e6f7ebc6094`. Schéma 59 conservé. Les sources du paquet restent immuables ; ce compte rendu est ajouté après compilation.

Windows : installateur `Zentra_1.63.0_x64-setup.exe`, 23 394 505 octets, SHA-256 `E2F1C7F3022B37038649D383A99C0C6166F170DC34FD5CBFB1A39521B00479E5`. Compilation locale, provenance et signature Tauri/Ed25519 vérifiées. Fichiers immuables publiés sur Supabase puis retéléchargés et comparés. Pas de signature Authenticode. **Promotion de `latest-windows.json` en attente** : Zentra est ouverte sur le PC, ce qui empêche les essais isolés du programme exact et du remplacement de 1.61. L'application de l'utilisateur n'a pas été fermée de force. Le canal continue d'annoncer 1.62.0 jusqu'à cette vérification ; le nouvel installateur est disponible séparément.

macOS : compilation universelle Intel/Apple Silicon réussie sur Codemagic, signature ad hoc contrôlée par `codesign`, architectures contrôlées par `lipo`. DMG de 49 979 918 octets, SHA-256 `B1FE13C5389889915AEE2D6692E9055E00201221FB02F50668E87000A6094D80`. Archive de mise à jour de 49 947 172 octets, SHA-256 `F0DFFB22B0674515301EE71EFFA4233871FA8AC27DB5987AC8C117BFA0136C43`. Version, identifiant, deux architectures, endpoint Mac et clé publique vérifiés localement ; signature Tauri produite et vérifiée indépendamment. Objets publics identiques aux fichiers contrôlés. `latest-macos.json` annonce 1.63.0 depuis 20:51 UTC, cache 60 secondes. Pas de notarisation ni d'essai sur un Mac client.

iPhone personnel : compilation réussie depuis `2f37960dd2163997cbcab7cbfdf51a8ca3aa14e0`. IPA ARM64/iPhoneOS, iOS 15 minimum, 24 893 563 octets, SHA-256 `476F5ADA874AF4A4CBC3B023C334AB0C0315627BE9C6D684C894FF1C828B710C`. La licence signée intégrée correspond au nouvel identifiant communiqué par le propriétaire et a été acceptée par le serveur ; les cinq autorisations précédentes restent valides. Le panneau de récupération et la clé de vérification sont présents. Fichier livré uniquement au propriétaire, à signer avec Sideloadly/AltStore. Installation, activation et navigation sur son iPhone physique restent à confirmer. Aucune licence personnelle n'est publiée sur les canaux clients.

Les résultats automatisés ne garantissent pas l'absence de tout bug. Les limites de traduction, de certification suisse et de validation sur appareils clients documentées précédemment restent applicables.

## Notes pour les prochaines corrections

Chaque correctif livré reçoit un nouveau numéro dans les métadonnées de version et une entrée dans `desktop/src/appReleaseNotes.ts`. Conserver les anciennes entrées ; y décrire uniquement le contenu réellement inclus. Les notes du manifeste Windows/macOS doivent correspondre au paquet vérifié. L'autorisation d'une licence personnelle reste une opération séparée et les paquets personnels ne sont jamais publiés sur le canal public.
