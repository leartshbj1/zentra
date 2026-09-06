# Remboursements clients depuis Banque

Ce lot relie les débits d’un relevé camt.053 aux remboursements d’avoirs clients. Il complète le parcours local Tauri ; il n’envoie aucun ordre de virement.

## Parcours

Dans **Banque**, ouvrez **Rapprocher un remboursement** sur un débit. Un remboursement déjà comptabilisé peut être associé au relevé. Un écart de dates demande un motif et conserve les dates et écritures d’origine. Si le remboursement n’est pas encore saisi, **Enregistrer un remboursement client** propose les avoirs disposant du montant nécessaire. La date et le montant reprennent le débit affiché. Une pièce PDF ou image peut être ajoutée ; elle est reliée au règlement et au projet de l’avoir.

Le rapprochement donne accès à l’avoir client et à ses justificatifs. **Dissocier du relevé** conserve le remboursement et sa comptabilisation, puis ajoute un historique motivé. La correction financière se fait ensuite depuis l’avoir. Tant que le remboursement conservé n’est pas corrigé, le débit propose de le rapprocher à nouveau, sans offrir une seconde création.

Une réponse interrompue apparaît dans **Demandes à vérifier**, même lorsque le mouvement est masqué par le filtre courant. La demande, son identifiant et les octets du justificatif sont conservés dans IndexedDB avant l’appel natif. Ils restent disponibles après fermeture/rechargement. Les fichiers sont stockés sous forme de buffers binaires pour les moteurs WebKit qui ne prennent pas en charge leur stockage direct comme `File`. Les anciennes copies `File` restent lisibles.

Retirer une demande locale enlève uniquement cette copie de reprise et actualise le relevé. Cela ne supprime aucune opération enregistrée. Un stockage de reprise indisponible bloque le nouvel appel financier. Les actions restent indisponibles en lecture seule.

## Intégrité et exports

- Transaction SQLite immédiate pour le règlement, ses écritures, la preuve bancaire, la demande et l’éventuel justificatif ; installation du fichier avant validation et suppression du fichier préparé en cas d’échec.
- Débit CHF définitif, sans extourne, compte associé, règlement unique et référence bancaire stable. Le montant et la date sont revérifiés contre ceux présentés au formulaire.
- Rapprochement exclusif entre les sources bancaires, immutabilité du mouvement et du journal d’origine, demandes rejouables seulement avec le même contenu.
- Un rapprochement d’un remboursement existant ne crée aucun second remboursement ni mouvement de TVA.
- Les débits clôturés permettent l’association administrative d’une pièce existante, sans permettre une nouvelle écriture à leur date. L’index des pièces de clôture conserve l’état des associations à la date de clôture.
- Les preuves incohérentes apparaissent dans les contrôles comptables. Les archives CSV, JSON et les sauvegardes conservent les liens, dissociations et demandes. Le dossier de clôture comprend le CSV des rapprochements clients et leur preuve.
- Migration additive du schéma 56 vers 57, sans inventer de rapprochement pour les anciens remboursements.

## Interface et validation

Le formulaire réutilise la palette, les dialogues et les transitions communes. Sur téléphone, son pied de formulaire compact conserve les actions accessibles, le choix du remboursement reste une grande cible tactile et les demandes de reprise occupent une seule colonne. Banque n’exige plus de comptes de salaires lorsque la paie est inactive et qu’aucune paie n’a été comptabilisée.

Les tests natifs couvrent les montants et dates, la TVA, les rejouements, l’exclusivité, les corruptions de preuve, le rollback avec pièce, la clôture, la migration et la restauration d’une sauvegarde. Le parcours `desktop/tests/bank-customer-refund-journey.mjs` couvre Edge et WebKit à 320, 390 et 1440 px, avec/sans justificatif, réponses interrompues, rechargement, association, dissociation, reprise, lecture seule et indisponibilité du stockage. Ses données sont synthétiques ; les commandes financières réelles sont vérifiées séparément en Rust.

Ce lot source ne vaut pas publication d’un installateur, mise à jour stable, validation sur un téléphone physique ou disponibilité sur les boutiques mobiles.

Validation du 6 septembre 2026 : 726 tests d’interface réussis ; suite native complète de 606 tests réussis et un test préexistant ignoré, puis 10 scénarios ciblés réussis après ajout du contrôle de dissociation post-clôture ; `cargo clippy --locked --all-targets -- -D warnings` et `pnpm build:web` réussis. Les parcours Edge et WebKit finaux passent aux trois largeurs, sans débordement global ni exception de page. La construction conserve l’avertissement existant sur la taille de certains modules. Les preuves locales figurent dans `.qa/bank-customer-*.log` et `.qa/bank-customer-{edge,webkit}/report.json`.
