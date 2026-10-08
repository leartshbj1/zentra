# Zentra US — prochaine verticale fournisseurs

Revue du commit `6e81657e8e6d1cae2c06aabffe121674f5f348b8`, en lecture seule. Cette note prépare le développement ; elle ne livre pas un module achats ni une nouvelle migration. Aucune donnée, aucun compte bancaire ou abonnement n'a été modifié.

## État réellement présent

`accounting/postings.ts` contient `VendorBill`, `postVendorBill` et `postVendorPayment`. Les règles numériques, partie double et méthode cash/accrual y sont réutilisables. Le coût inclut la taxe d'achat et ne crée aucun crédit de TVA US. Ces primitives ne constituent pas un cycle fournisseur enregistré dans l'ERP.

Les collections et kinds de `runtime-types.ts`, actions de `erp-request.ts`, `runtime.ts`, reçus de `runtime-store.ts`, relecture de `runtime-validation.ts` et application des deltas dans `runtime-sync.ts` ne comprennent pas de fournisseurs, factures fournisseur ou paiements fournisseur. La relecture du journal n'admet actuellement que les sources de vente/client. Le SQL de persistance ferme aussi les kinds, actions, relations et journaux à ce périmètre. Il faut donc construire une verticale entière ; ajouter seulement un bouton ou appeler la primitive comptable serait insuffisant.

## Première tranche cohérente

Parcours : fournisseur → facture fournisseur approuvée manuellement → paiement enregistré. Les trois commandes proposées sont `save_vendor`, `record_vendor_bill` et `record_vendor_payment`, initialement réservées à un propriétaire, administrateur ou comptable admis avec le droit Gestion actuel.

La fiche fournisseur est modifiable ; son identité et adresse sont figées dans chaque facture validée. La facture validée est immuable. Les paiements sont des enregistrements séparés ajoutés à l'historique, avec montant, référence, date de paiement, date comptable et période. Un paiement enregistré ne signifie jamais qu'un virement est exécuté.

La saisie transmet `netMinor` et `purchaseTaxMinor` en USD, avec des entiers décimaux exacts. Le serveur calcule le total et dérive `paidBefore` des paiements durables. Il refuse un paiement nul, négatif, supérieur au solde, lié à une autre entreprise ou à une période fermée. Premier périmètre limité aux comptes de charges et au cash flow operating ; actifs, remboursements et autres catégories nécessitent une étape séparée.

L'approbation mémorise l'utilisateur financier et l'instant serveur, la source `manual_entry` et la référence du justificatif. Le navigateur ne fournit pas de `validatedBy` faisant autorité, de journal calculé, de montant total approuvé, de rôle ou de preuve d'un fournisseur. Import/OCR/JEV pourront préparer un brouillon ultérieurement, sans se substituer à cette admission et à l'approbation.

## Persistance et compatibilité à traiter explicitement

Une migration nouvelle doit ajouter les gardes des nouveaux records, les relations fournisseur→facture→paiement par entreprise, l'immuabilité de la facture approuvée et l'historique append-only des paiements. Le commit garde les verrous entreprise→pays→head, CAS global, replay acteur/clé/hash et écrit atomiquement document, paiement éventuel, journal, audit, reçu et delta. Les protections fiscales Stripe des factures clients restent en place.

Les anciennes migrations et archives ne doivent pas être réécrites. Les factures fournisseur utilisent une référence externe : aucun compteur de factures clients n'est réutilisé. La compatibilité des anciens lecteurs n'est pas garantie par le seul maintien de `schemaVersion:1` : leurs listes de kinds/actions sont fermées. Avant l'ajout, choisir et tester une transition explicite de capacités/version du transport. Les anciennes révisions, preuves fiscales, reçus et soldes doivent rester lisibles et inchangés ; ne pas cacher les nouveaux journaux à un ancien lecteur pour lui donner une comptabilité incomplète.

La clé ERP actuelle peut atteindre 232 caractères. Le préfixe comptable `vendor-payment:` en consomme 15, pour une borne de 240. Le nouveau parcours doit donc définir une clé fournisseur bornée à 225 caractères ou une identité interne dérivée et documentée ; aucune troncature susceptible de collision ni réduction silencieuse de la borne des commandes historiques.

Contraintes SQL actuelles à préserver/tester : au plus 20 changements et 2 événements d'audit par commit, unités mineures entières de 36 chiffres, événement de 2 Mio maximum avec rollback complet, page de 4 Mio maximum, RLS et RPC serveur exclusivement.

## Fichiers et recette prévue

- Domaine dédié achats, réutilisant `money.ts`, adresses/contacts et primitives de `accounting/postings.ts`.
- `runtime-types.ts`, `erp-request.ts`, `runtime.ts`, `runtime-validation.ts`, `runtime-store.ts` et `runtime-sync.ts`.
- `public-projection.ts`, session/workbench navigateur, reçus corrélés et termes traduits.
- Migration additive distincte : persistance et delta existants dans `20261007222349_international_us_erp_persistence.sql`, `20261007224820_international_us_erp_delta_stream.sql` et gardes de header dans `20261007225725_international_us_erp_seller_snapshot.sql` sont des contrats à préserver, pas des fichiers à modifier.

Recette obligatoire : ancien historique sans fournisseur ; relations et orphelins ; isolation interentreprises ; approbation liée à l'acteur réel et révocation pendant attente ; CAS, replay et réponse perdue ; paiements partiels/surpaiement ; cash/accrual exacts ; période fermée ; mutations SQL directes refusées ; rollback global et continuité des deltas ; clés longues ; preuves fiscales de vente inchangées.

Tests exécutés pour cette note : aucun nouveau test. La phase fiscale précédente conserve sa preuve de 2 780 tests ; elle ne valide pas ces futurs achats. Migration proposée : conception ci-dessus uniquement, aucun SQL créé ou appliqué. Risques : compatibilité du transport, représentativité d'une base de staging, deux connexions PostgreSQL réelles, latence d'admission et traitement comptable à valider professionnellement. Cette première verticale n'inclut ni OCR/import, paiement bancaire, avoir fournisseur, immobilisation ni déploiement de production.
