# Avoirs fournisseurs : remboursement reçu — travail local du 6 septembre 2026

Le dossier devis/acompte/solde est publié en 1.35, comme décrit dans `RELEASE-1.35.md`. Le présent travail poursuit l’audit général ; il n’est pas encore publié et ne constitue pas une fin d’audit.

## Parcours désormais implémenté

Depuis Achats et fournisseurs, un avoir validé en CHF peut recevoir un remboursement total ou partiel. La somme disponible déduit les compensations et les remboursements actifs. Une correction datée rétablit le montant exact et conserve l’événement initial. L’enregistrement et son écriture bancaire sont atomiques ; le compte fournisseur reprend celui de l’avoir d’origine, même après changement des paramètres.

Le schéma 52 conserve les demandes pour éviter les doubles écritures, protège les événements, les montants, les dates, le solde historique et les liens au journal. Une extourne isolée depuis le journal est refusée. Les remboursements sont présents dans la sauvegarde, l’export CSV des achats et le journal du dossier comptable. Les migrations ne créent aucun règlement ni rapprochement.

En méthode TVA reçue, le remboursement règle les lignes de l’avoir à sa date effective ; sa correction reprend leurs centimes exacts. En méthode convenue, le virement ne crée pas une seconde correction de TVA. La ventilation existante entre catégories déductibles et non déductibles est conservée. Références relues : [LTVA, art. 40 et 41](https://www.fedlex.admin.ch/eli/cc/2009/615/fr#art_41), [contrôles AFC](https://www.estv.admin.ch/fr/deroulement-dun-controle-tva). L’inspiration de parcours est la distinction entre avoir et paiement dans la [documentation officielle Odoo](https://github.com/odoo/documentation/blob/19.0/content/applications/finance/accounting/customer_invoices/credit_notes.rst).

Le formulaire fonctionne au clavier et au toucher, conserve le montant d’origine lors d’une correction et respecte la lecture seule. Une lecture échouée après succès de l’écriture ne relance que les lectures. Les statuts `pending` et `partial` ont leurs libellés français et les cartes d’achats affichent la devise de leur document.

Depuis Banque, un crédit définitif du relevé camt.053 peut être associé à un remboursement existant, ou créer le remboursement d’un avoir avec son justificatif PDF ou image. La création enregistre le montant et la date du relevé, le paiement, son écriture, le rapprochement et la pièce dans une seule opération. Les rapprochements des factures clients, factures fournisseurs, dépenses et remboursements sont mutuellement exclusifs. Une dissociation conserve le paiement et son historique ; elle est nécessaire avant de corriger le remboursement. Une différence de dates lors d’un rapprochement existant doit être justifiée et ne déplace pas l’écriture ni la TVA.

Une reprise après perte de réponse ne crée pas un second paiement. Un échec à la validation finale de la transaction retire également le fichier déjà installé. La sauvegarde restaure les pièces et les preuves de reprise. L’export CSV comprend les créations, rapprochements et dissociations ; le dossier comptable indexe le justificatif, son remboursement, son projet et son empreinte vérifiée. La pièce rejoint un projet si toutes les lignes de l’avoir sont rattachées au même projet. Depuis Banque, « Voir l’avoir fournisseur » ouvre et affiche directement l’historique concerné ; des justificatifs supplémentaires peuvent y être ajoutés.

## Vérification actuelle

- 702 tests d’interface réussis ; TypeScript et compilation de production réussis ; Clippy sur toutes les cibles avec avertissements interdits réussi.
- Huit parcours de remboursement manuel précédemment réussis sur 320, 390, 768 et 1440 pixels, chacun avec et sans droit d’écriture.
- Huit nouveaux parcours de navigateur sur interface compilée aux mêmes formats : création bancaire, fichier invalide, refus conservant la saisie, réponse perdue après écriture, reprise avec la même demande, lecture échouée après succès, navigation vers l’avoir et ses pièces, ajout de justificatif, dissociation et nouveau rapprochement. Une seule création comptable simulée, bon routage des commandes et respect de la lecture seule. Captures inspectées ; pas de débordement détecté ni d’erreur JavaScript.
- Suite native complète : 556 succès, aucun échec, un test ignoré. Les anciennes fixtures de migration retirent désormais les déclencheurs et vues plus récents avant de reconstruire les schémas v14, v42 et v50. La première exécution avait révélé une fixture v14 conservant un déclencheur v52 ; l’échec puis sa correction sont conservés dans les journaux.
- Dix tests natifs bancaires ciblés réussis, dont un contrôle des exports ajouté après la suite complète. Ils couvrent les demandes concurrentes, l’absence de double écriture/TVA, les dates justifiées, les mouvements et fichiers invalides, les périodes fermées, l’échec après installation du fichier, l’exclusivité entre remboursements, les reprises après dissociation, la restauration avec empreinte, les projets multiples, la conservation des pièces, le CSV, l’index du dossier comptable et la migration depuis le schéma 51.

Preuves locales : `.qa/bank-credit-native-full-final.log`, `.qa/bank-credit-native-targeted-final.log`, `.qa/bank-credit-ui-full.log`, `.qa/bank-credit-clippy.log`, `.qa/bank-credit-web-build.log`, `.qa/bank-credit-refund/report.json` et captures du même dossier. Les scénarios navigateur utilisent des données et réponses natives simulées ; les transactions SQLite, les pièces réelles et les exports sont vérifiés séparément par les tests natifs.

## Travail restant avant publication de ce parcours

Construire et vérifier les nouveaux paquets sur chaque plateforme avant leur publication. La version publique reste 1.35 ; aucune nouvelle publication ni validation sur téléphone physique n’est annoncée ici. La refonte locale de l’interface est décrite dans `DESIGN-EXPERIENCE-2026-09-06.md`.
