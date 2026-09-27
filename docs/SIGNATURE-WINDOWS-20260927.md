# Distribution Windows reconnue — préparation

État au 27 septembre 2026, 22 h 50 (Europe/Zurich). Aucun achat, inscription, certificat ni changement de politique de sécurité effectué.

## Diagnostic établi

L'updater de Zentra 1.90.5 télécharge correctement 1.90.6 et valide sa signature Ed25519. Windows refuse ensuite le lancement de l'installateur (4551, événements Code Integrity 3033/3077). L'installateur est `NotSigned` pour Authenticode ; la politique Smart App Control est active (`VerifiedAndReputablePolicyState=1`, lecture seule). Une signature de mise à jour Zentra n'est pas une identité d'éditeur reconnue par Windows.

Preuves : `outputs/release1906/upgrade-smoke/windows-signing-diagnosis.json`, `windows-code-integrity-refusal.json`, `updater-install-refused-proof.json`. Ce PC reste en 1.90.5, sans perte dans le profil fictif contrôlé.

Complément 23 h 31 : une explication du code 4551 est ajoutée à l’interface, avec le diagnostic original replié. Quatre parcours simulés Edge/WebKit à 320/1440 px vérifient sa lecture, le détail conservé et sa remise à zéro après nouvelle recherche ; trois régressions de badge/hors ligne passent aussi. Dix tests ciblés, TypeScript et build réussis. C’est un correctif d’information non publié, sans signature d’éditeur ni installation débloquée.

## Deux parcours légitimes

1. **Distribution directe avec signature d'éditeur.** Microsoft Artifact Signing accepte les organisations suisses, sous validation de leur identité. Les particuliers restent limités aux États-Unis et au Canada : ne pas inscrire un particulier suisse comme société. Il faut confirmer le statut juridique de Zentra avant de choisir le dossier. La [procédure officielle actuelle](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) prévaut sur les tableaux de régions plus anciens. La signature ne garantit pas une réputation SmartScreen immédiate.
2. **Microsoft Store avec un paquet MSIX.** Microsoft re-signe le paquet après certification ; cette possibilité ne s'applique pas à notre installateur EXE actuel. Il faut une identité Partner Center, un empaquetage MSIX, ses tests d'accès aux fichiers/données/protocoles et la certification. La [documentation des signatures](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) distingue ces parcours. L'[inscription individuelle gratuite](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer) commence sur `storedeveloper.microsoft.com`, comporte une vérification d'identité et impose le compte entreprise si le vendeur est une entreprise.

## Travail technique après choix et validation d'identité

Pour la distribution directe : intégrer le prestataire dans la commande de signature Tauri, signer les exécutables puis l'installateur, vérifier la chaîne et l'horodatage, calculer ensuite les empreintes et la signature updater, enfin tester le fichier exact sur le PC protégé. La [documentation Tauri](https://v2.tauri.app/distribute/sign/windows/) prévoit `signCommand` pour les prestataires externes. Les secrets restent dans le service de signature, jamais dans le dépôt ni les journaux.

Pour le Store : récupérer l'identité réellement attribuée, préparer le manifeste MSIX avec cette identité, conserver et vérifier la migration des données de l'installation existante, puis effectuer la soumission. Ne pas inventer le Publisher, ne pas modifier les anciens paquets ni prétendre à une certification avant son résultat.

La désactivation de Smart App Control, un certificat auto-signé ajouté aux racines de confiance et un changement de nom destiné à éviter la politique ne constituent pas une livraison client acceptable. Les coûts, conditions et l'identité doivent être confirmés avant toute souscription ; aucune formule payante n'est engagée ici.
