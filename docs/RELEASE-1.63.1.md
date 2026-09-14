# Zentra 1.63.1 — assurance accidents et fiche de salaire

Le parcours pouvait demander indéfiniment de configurer l’AAP : son taux existait, mais le nom de l’assureur manquait. Le nom n’était contrôlé qu’après sélection de la cotisation, alors que les suggestions ne sélectionnaient aucune cotisation accidents sans ce nom. Réenregistrer le taux créait plusieurs contrats, supprimant ensuite la suggestion automatique réservée au contrat unique.

Le guide demande désormais directement le seul champ assureur, en conservant les autres assurances et le plan de pension. Une cotisation déjà enregistrée peut être choisie explicitement pour la fiche. En présence de plusieurs contrats, aucune sélection arbitraire ni suppression n’est effectuée. Le formulaire de création devient une action secondaire explicite. Les contrats sont comparés à la date de paie, y compris quand leur validité commence en cours de mois. Les montants déjà saisis restent conservés ; un échec d’enregistrement reste visible et peut être réessayé.

Le choix explicite est repris après relecture des définitions. Les contrats inactifs, hors période ou LPP d’une autre personne sont exclus. Les propositions auparavant écartées ne sont pas réintroduites. Aucun taux, calcul légal, schéma de données ou contrôle natif n’a été assoupli.

Vérifications : défaut reproduit par un test de diagnostic avant correction ; 1 530 tests d’interface réussis. Douze parcours Edge/WebKit à 320 et 1 440 pixels créent une fiche avec salaire conservé et une seule AAP : assureur absent, nouveau contrat, contrats multiples, validité débutant en cours de mois et refus puis reprise de l’enregistrement. Tests réalisés avec données synthétiques, sans modification des salaires du propriétaire. 


## Vérification et publication Windows

Source applicative : `f38d8831dc3a638d1fde44ddcb5a67b01e724122`. Le commit suivant ne change que les tests et le vérificateur de profils. Les 12 parcours assurance, 10 parcours première fiche/ajout de collaborateur/reprise et 6 parcours continuité de brouillon sont réussis. TypeScript/Vite et le test HTTPS natif de licence sont réussis.

Le nouvel exécutable a passé six démarrages isolés, dont le remplacement de la 1.61.0 avec données synthétiques : intégrité SQLite, clés étrangères, pièces jointes et identité protégée conservées. Il ne s’agit pas d’une exécution de l’installateur NSIS ni d’un essai sur le profil du propriétaire.

Installateur : `Zentra_1.63.1_x64-setup.exe`, 23 455 807 octets, SHA-256 `ED504EF660CCAB8059758E33D6545CA37C9CD8360B06BAF52B675376F822D452`. Signature de mise à jour Tauri/Ed25519 vérifiée ; absence de certificat Authenticode conservée.

Le canal Windows a été promu de 1.62.0 à 1.63.1 le 14 septembre 2026 à 00:37 UTC, après relecture et comparaison des fichiers publics. Cache 60 secondes. Le manifeste partagé historique 1.46.1 est inchangé. Preuves locales : `.qa/public1631/public-Promote-proof.json` et `.qa/zentra-installer-packaged1631-final/report.json`.

## Publication macOS

Le canal macOS a été promu à 1.63.1 après vérification SHA-256 des fichiers publics et de la signature de mise à jour Ed25519. Source applicative identique à Windows. Archive universelle Intel/Apple Silicon, macOS 12 minimum, signature Apple ad hoc vérifiée sur le service de compilation ; aucune notarisation Apple ni validation sur un Mac physique. Le canal Windows et le manifeste partagé sont restés inchangés.

DMG : 49 983 999 octets, SHA-256 `C6B415A543D4DE5D31FCFCC462B994CDEC4AE92F7AA6166BFE867D6B5FBC6E13`. Publication vérifiée à 2026-09-14T00:41:13.7149836+00:00.

La page de téléchargement publique a été mise à jour avec les versions, tailles et empreintes Windows/macOS vérifiées. Déploiement Sites 131 réussi à 00:43 UTC, source `d7e45a4664cf05584f9bae98613977619b9479be`, environnement de licence révision 24 inchangé. Tests du contrat de téléchargement (4) et build du site réussis. L’IPA personnel reste exclu du téléchargement public.

## IPA personnel iPhone

IPA ARM64 iPhoneOS 1.63.1 compilé depuis `b7578df720ba75085815e4e84670c1c0c06fa953`, identifiant `ch.zentra.mobile`, iOS 15 minimum. Les trois tests UIKit de zones tactiles, actions répétées, clavier et contraste sont réussis sur simulateur iOS 26. Le paquet exact contient la licence propriétaire attendue pour l’identité iPhone 00637900, signature Ed25519 vérifiée. Le serveur a accepté cette licence après le déploiement du site, sans remplacer le jeton embarqué.

Fichier privé livré dans Téléchargements : `Zentra-1.63.1-iPhone-PERSONNEL.ipa`, 24895062 octets, SHA-256 `7B8492ABFE02BCFE42FD7CF6EE93F8EF37AA61ECAE48FD75CA9C04C483A3E2AA`. Installation par signature Sideloadly/AltStore, par-dessus la version existante avec le même compte Apple. Aucun test sur iPhone physique ni signature Apple de distribution ; le paquet personnel n’est pas publié pour les clients.
