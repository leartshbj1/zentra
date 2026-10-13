# A50 — connexion des entreprises créées pendant l’essai

## Défaut confirmé

Le serveur construit les entreprises d’essai sous la forme
`org_trial_<32 caractères hexadécimaux minuscules>` et conserve cet identifiant
après l’achat. Le client exigeait `org_<UUID>` lors de la validation d’une
session. Le premier poll approuvé pouvait donc retourner HTTP 200 et une
licence, puis être refusé avant leur adoption locale.

Ce défaut correspond à la recette CI307/source
`b50214696754365b3f4b9d889bfefd0d3816e36a` : compilation réussie, onze tests
de profil réussis, puis échec fermé `private_protocol_failed`. Les logs A41
montrent start 201, approve 200 et poll 200 ; aucun parcours compte natif complet
n’est revendiqué pour cette exécution.

## Correction bornée

- Un validateur d’entreprise accepte l’ancien contrat UUID et le contrat trial
  exact. Aucun autre identifiant arbitraire n’est admis.
- Les validations de session, jeton, rôle, installation et licence restent actives.
- Trois tests Rust purs couvrent les formats acceptés, les valeurs malformées,
  les gardes de session et la liaison à l’installation.
- Le canal privé émet uniquement des marqueurs d’étape fermés. Le coordinateur
  exige leur ordre complet et peut identifier l’étape d’une fermeture ou d’un
  délai dépassé sans publier les erreurs natives, chemins, réponses ou secrets.
- La recette CI compile une nouvelle bibliothèque, vérifie les onze contrôles de
  profil, exécute les trois nouveaux tests exacts, puis connecte deux stores et
  les rouvre dans un second processus du même binaire vérifié.

Aucune migration, modification d’entreprise, réinitialisation, changement de
tarif ou affaiblissement d’authentification. Version 1.90.15 et schéma 62 conservés.
Les raccords G4 préparés séparément ne font pas partie de ce lot.

## Validation locale réellement exécutée

- Contrats CI existants : 253 contrôles et 4 032 combinaisons YAML réussis.
- Nouveaux contrats de diagnostics fermés : 317 contrôles réussis.
- Syntaxe Node des deux coordinateurs et `git diff --check` réussis.
- Les sept fichiers A26 restent identiques aux empreintes historiques vérifiées.
- Deux revues indépendantes confirment la cause et le correctif.

Ces ensembles sont distincts des onze tests de profil de CI307. Aucun Cargo,
exécutable natif ou contournement de Windows App Control n’a été lancé localement.
Les trois nouveaux tests Rust et le parcours compte corrigé doivent encore être
exécutés dans la CI autorisée. G1/G2/G4/G5/G6 et la disponibilité produit restent
ouverts ; ce correctif ne prouve pas l’exécution d’Autopilote.
