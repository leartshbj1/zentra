# Zentra 1.63.0

## Changements

- Navigation Apple : l'abonnement aux clics est établi une seule fois par session web. Les mises à jour de sélection et de visibilité conservent ce canal. Les boutons UIKit officiels et le dock AppKit restent utilisés sur les systèmes compatibles. Le panneau UIKit est replacé devant la vue web. Les événements reçus pendant une fenêtre bloquante ou après démontage sont ignorés ; une erreur native restitue les commandes HTML.
- Paramètres → Sauvegardes et mises à jour : « Voir les nouveautés de cette version » et « Voir les mises à jour précédentes ». Notes intégrées en français, allemand, italien et anglais, disponibles hors ligne. L'historique contient les versions documentées 1.60 à 1.63 et distingue le correctif iPhone personnel 1.62.1. Les versions futures ne sont pas présentées comme des mises à jour antérieures. Une version inconnue n'emprunte pas les notes d'une autre version.
- Factures fournisseurs : intègre les parcours de préparation, consultation, vérification et paiement précédemment validés dans les audits de qualité. Les contrôles comptables et l'interdiction des doubles écritures restent appliqués.

## Diagnostic des clics Apple

Le même objet JavaScript `Channel` était envoyé à chaque appel de configuration. Tauri 2.11 recrée alors le canal Rust avec un compteur à zéro et termine le canal remplacé. Le JavaScript supprime son callback à réception de cette fin : les boutons peuvent rester visibles sans transmettre les clics. Le test de non-régression reproduit cette situation avec la vraie classe `Channel` de Tauri. L'inscription est désormais optionnelle côté natif et fournie seulement au premier appel. Une file commune ordonne la fermeture de l'ancienne session avant la connexion suivante, y compris sous React Strict Mode.

## Vérifications en cours de préparation

- 1 525 tests d'interface réussis, dont reproduction du défaut des canaux, clics successifs iOS/macOS, masquage, retour, déconnexion et récupération.
- 24 parcours Edge/WebKit, français/allemand/italien/anglais, largeurs 320, 390 et 1 440 : notes courantes, historique, mode mobile, hors ligne, sans installation involontaire ni débordement horizontal. Inspection visuelle du petit écran allemand.
- TypeScript et build Vite réussis. Les avertissements existants sur les gros fragments restent présents.
- Tests UIKit de coordonnées réelles dans une UIWindow, pressions répétées, clavier et contraste inclus dans le workflow iPhone. Ils ne constituent pas un essai sur l'iPhone physique du propriétaire.

La distribution de cette version doit être renseignée après compilation et vérification des fichiers. La préparation des sources ne constitue pas une publication, ni une garantie d'absence de tout bug.

## Notes pour les prochaines corrections

Chaque correctif livré reçoit un nouveau numéro dans les métadonnées de version et une entrée dans `desktop/src/appReleaseNotes.ts`. Conserver les anciennes entrées ; y décrire uniquement le contenu réellement inclus. Les notes du manifeste Windows/macOS doivent correspondre au paquet vérifié. L'autorisation d'une licence personnelle reste une opération séparée et les paquets personnels ne sont jamais publiés sur le canal public.
