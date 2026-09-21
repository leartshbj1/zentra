# Assistant Automation — contrôle du 21 septembre 2026

## Validé

- Windows CircleCI job 17, source `cf61ba58f21416450b039fbe0b33bcf94370534d`, terminé avec succès : 39 tests d’interface et 69 tests Rust passent (2 tests préexistants ignorés). Les 9 tests de réception fournisseurs passent, dont confirmation finale idempotente, écriture équilibrée et annulation atomique en cas d’erreur.
- Contrôle local TypeScript sans erreur ; 24 tests ciblés UI/traductions passent après ajout des libellés fournisseur.
- Recette navigateur synthétique à 390 px : document PDF, modification de référence, ajout/sélection de fournisseur sans quitter le formulaire, refus de TVA vide et reprise après correction. L’enregistrement de cette recette est simulé ; les écritures réelles sont couvertes par les tests Rust ci-dessus.
- Nouvelle fiche fournisseur conservant la facture ouverte, préremplie par les informations extraites. La création reste une action explicite. Aucun IBAN n’est prérempli ni paiement envoyé.

## Non validé / restant

- La connexion réelle Infomaniak est bloquée par HTTP 500 `unexpected_error` sur les dossiers, avec et sans `with=ik-static`. La clé dédiée contient le scope officiel `workspace:mail`, l’adresse exacte est reconnue par la liste API, et le webmail ouvre la boîte normalement. Aucune lecture des mails existants par Zentra ni facture fictive envoyée dans cette séquence.
- La facture fictive `ZT-QA-20260921-01`, CHF 108.10, est prête pour un envoi après connexion. Ne pas présenter les tests simulés comme un test e-mail de bout en bout.
- Synchronisation mail lorsque Support est fermé encore désactivée ; GitHub planifié indisponible pour facturation. Aucun remplacement de planificateur n’a été mis en production.
- Audit visuel exhaustif des menus, essais Apple et publication de la nouvelle application encore à faire. Version distribuée actuelle : 1.77.0.

Les améliorations d’ajout fournisseur postérieures à `cf61ba58` sont uniquement frontend ; aucune nouvelle modification Rust depuis le job 17.
