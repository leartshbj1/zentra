# A52 — recette native de création d’un devis

La recette G4 est raccordée au job Windows de validation existant, sur une
nouvelle source distincte d’A50. Les deux modules Rust sont exclusivement
`cfg(all(test, windows))`. Aucun IPC, worker produit, notification ou changement
de version/schéma n’est introduit par ce lot.

Le même binaire fraîchement compilé doit passer les onze tests de profil,
les trois régressions de session, puis la connexion/réouverture de deux stores
et le parcours G4 : publication initiale, source Support API fictive approuvée,
vraie décision de préparation, brouillon canonique, publication coordonnée,
réception exacte sur le second store et ronde suivante sans nouvelle création.

Le contrôle métier exige trois radiateurs du catalogue, prix unitaire 19 900
centimes, total CHF 59 700 centimes, remise et TVA zéro. Reçu, IDs, brouillon
non numéroté, publication figée et chaîne d’audit restent obligatoires.

Les secrets de contexte sont retirés avant compilation et ne sont transmis au
parcours qu’en mémoire privée. Ils ne figurent ni dans Git ni dans les artefacts.
Les filtres CI, branches, contextes, jobs de release et sources A26 restent
inchangés. Le seul changement YAML remplace le coordinateur de compte par le
coordinateur G4. Un nouveau pin exact de révision est requis avant lancement.

## Vérification locale et limites

- 272 contrats du coordinateur Support et 352 contrats CI / 4 032 combinaisons
  YAML réussis. Aucun réseau, Cargo ou processus natif exécuté par ces contrats.
- Revue indépendante des raccords, signatures/ownership Rust et preuves fermées.
- Le retrait des deux déclarations retrouve les objets Rust A50 ; le remplacement
  inverse de la seule commande retrouve le YAML A50. Inventaire A26 inchangé.
- La présence des sources ne prouve pas la compilation ou le succès natif.

Le nominal utilise une source API, un classement Support approuvé par humain
et un client/article fictifs préexistants. Il ne prouve pas la réception d’un mail
externe, la création d’un nouveau client, toute la matrice de pannes ou l’activation
Autopilote dans l’application cliente. Ces limites restent explicites dans le DTO
public. Un workspace Support ou un head déjà utilisé impose une revue, pas un
nettoyage ni une relance aveugle.

Les améliorations d’interface en parallèle sont volontairement exclues de ce lot
de recette native. Version 1.90.15 et schéma 62 conservés.
