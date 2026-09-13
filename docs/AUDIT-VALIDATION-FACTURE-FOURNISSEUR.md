# Validation des factures fournisseurs

Lot du 13 septembre 2026, branche `codex/app-quality-20260912`. Ce lot concerne le passage du brouillon fournisseur à la comptabilité et sa reprise après une interruption. Il ne constitue pas une nouvelle publication Windows, macOS ou iPhone.

## Parcours livré

- Le bouton principal annonce la prochaine action nécessaire : compléter la référence, contrôler le justificatif, vérifier les commandes ou valider. Il ouvre le réglage pertinent ou place le focus sur le choix demandé. Un choix n’est jamais coché automatiquement.
- Le total reçu apparaît en premier. La référence et le fournisseur restent entièrement lisibles dans le résumé, même lorsque la description de la fenêtre est raccourcie. Les notes conservent leurs retours de ligne.
- Toutes les commandes ouvertes du même fournisseur et dans la même devise apparaissent dans le contexte d’une facture indépendante. Pour une facture déjà rapprochée, seules ses commandes liées sont présentées. La lecture des lignes est progressive, par lots de vingt.
- Les comptes de charges, de TVA préalable et de dettes fournisseurs sont contrôlés avant l’envoi : existence, activité et type. Les comptes de charges particuliers des lignes sont aussi vérifiés. Ces contrôles reflètent ceux du code natif existant ; les règles de calcul et les écritures natives ne sont pas modifiées.
- Les corrections d’un brouillon déjà rapproché expliquent le passage par le rapprochement pour déverrouiller la saisie. Les réglages comptables et les exercices conservent le bouton de reprise de la facture.
- Une modification des données pertinentes annule les choix précédents et demande une nouvelle lecture. Revenir ensuite aux anciennes valeurs ne restaure pas les confirmations. Changer de langue ou actualiser des achats sans lien avec cette facture ne les annule pas.
- Le bouton de relecture et le bouton de validation ont des identités distinctes. La relecture annule explicitement l’action par défaut du clic : même avec un justificatif déjà présent, elle ne peut pas se transformer en soumission du formulaire. Un clic séparé est nécessaire pour comptabiliser.
- La validation finale distingue clairement comptabilisation et paiement. Elle ouvre ensuite le formulaire de paiement avec le solde courant, sans créer elle-même un règlement. Le total et son libellé redeviennent visibles dès la confirmation.

## Reprise et limites

Le pont natif distingue une réponse de validation perdue d’une validation acquittée dont la relecture échoue. La reprise lit la même facture et vérifie son état validé ainsi que la présence du lien vers son écriture comptable. Une facture absente, ambiguë ou partiellement chargée ne suffit pas à confirmer l’opération. Les actions restent verrouillées tant que le résultat n’est pas vérifiable ; la reprise ne renvoie pas la validation. Un refus dont la relecture montre encore le brouillon retrouve son explication et ses liens de correction.

L’empreinte de revue contrôle les données chargées dans l’interface et est revérifiée juste avant l’appel. Elle ne constitue pas un verrou transactionnel de version entre plusieurs appareils. La validation native existante reste l’autorité pour la transaction, la période, les doublons de référence, la TVA, les rapprochements et l’immuabilité du document. Ce lot ne modifie pas cette API ni le schéma de base.

## Vérifications

- 1 518 tests d’interface dans 180 fichiers, dont les cas d’invalidation de la revue et de reprise de validation : réussis.
- 9 tests natifs ciblés sur les factures fournisseurs : réussis. Ils couvrent notamment le cycle atomique et immuable, les périodes fermées, les écarts de prix et les règles de TVA pour les entreprises non assujetties.
- Contrôle des 84 textes de l’écran et de ses explications : traductions disponibles en allemand suisse, italien et anglais, avec le français comme langue source. Le message natif original est conservé dans un détail replié.
- Compilation TypeScript et Vite du code final : réussie. L’avertissement préexistant sur la taille de certains fichiers JavaScript reste présent.
- 32 recettes finales réussies : les quatre langues, les tailles 320 × 568, 390 × 844, 844 × 390 et 1440 × 1000, sur Chromium/Edge et WebKit. Les scénarios couvrent la référence, les confirmations explicites, les comptes inactifs, les corrections d’exercice, les données modifiées puis rétablies, plusieurs commandes, les longues lignes et notes, la lecture seule, les réponses perdues, la reprise et le passage au paiement. La relecture avec justificatif est contrôlée sans aucun nouvel appel de validation. Le total complet doit être visible après la confirmation.
- 8 recettes de régression réussies : ajout réel d’un justificatif dans la persistance de test, référence ciblée, détours comptes/exercices/rapprochement, choix de facture indépendante, écart bloquant, double clic, relecture après acquittement, réponse perdue et enregistrement d’un paiement partiel. Deux moteurs, quatre tailles d’écran.

Les preuves locales se trouvent dans `.qa/supplier-review-language-chromium/`, `.qa/supplier-review-language-webkit/`, `.qa/supplier-review-regression.log`, `.qa/supplier-review-all-ui-final.log`, `.qa/supplier-review-native.log` et `.qa/supplier-review-build-final.log`. Les recettes de navigateur utilisent la véritable interface avec une persistance isolée de test ; elles ne prouvent pas une installation sur un iPhone ou un Mac physique.
