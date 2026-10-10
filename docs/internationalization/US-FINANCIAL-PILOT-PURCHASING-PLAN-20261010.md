# Zentra US — achats manuels dans le pilote financier V5

10 octobre 2026. Plan avant développement, base `b1b1535`. La tranche de facturation `bf4ea9f` et sa livraison sont validées localement. L'objectif ERP US complet demeure actif. Ce plan raccorde maintenant fournisseurs, factures fournisseurs approuvées et règlements au même consommateur privé TEST, sans modification CH, production, abonnement ou distribution native.

## Existant vérifié

`runtime-types.ts`, `purchasing.ts` et `us-financial-kernel-runtime.ts` définissent déjà `save_vendor`, `record_vendor_bill` et `record_vendor_payment`. `createSupabaseUsFinancialPilotStore` dans `us-financial-pilot-store.ts` utilise la capacité cumulative invoicing V5 qui admet ces commandes et les événements de facturation courants. Les wrappers pilote et gardes SQL existants les autorisent avec admission atomique. **Aucune migration ni second livre ne sont prévus.** L'ancien profil purchasing, antérieur aux événements invoice, ne doit pas remplacer ce store ; les builders legacy nécessitant ErpState ne doivent pas provoquer de lecture du livre privé ou de repli ERP4.

Le pilote expose les fournisseurs mais pas les factures fournisseurs, leur détail et l'historique de règlements. Le vrai `UsFinancialBookViewV5` contient déjà ces données. Le gap est donc un contrat de présentation fermé, les routes/projections et l'interface de travail, pas un nouveau moteur comptable.

## Parcours et périmètre

1. Créer ou modifier un fournisseur avec les champs Contact existants. US/CH sont les pays d'adresse actuellement admis ; ce pilote ne prétend pas ouvrir toutes les adresses mondiales. Le serveur impose l'organisation. La révision globale protège les modifications ; les anciennes factures conservent leur snapshot fournisseur.
2. Saisir la facture originale reçue : fournisseur existant, référence, date, date comptable, échéance, période ouverte, montant net, taxe sur achat et référence manuelle de source. La taxe doit être explicite, y compris zéro ; aucune valeur vide n'est transformée en zéro. Montrer net/taxe/total USD exacts puis demander une confirmation humaine avant l'enregistrement.
3. Lire le registre et le détail : snapshot historique, montants, soldes, dates/période, référence/source et auteur/date d'approbation. Calculer le solde depuis tous les paiements autoritatifs, jamais la page affichée. L'historique des paiements est paginé et ne révèle pas les clés d'idempotence privées.
4. Enregistrer un règlement **déjà effectué**, partiel ou final, avec montant positif inférieur ou égal au solde courant, dates de paiement/comptabilité, période et référence. Afficher une revue du solde avant confirmation. Cette action ne transfère pas d'argent et n'appelle aucun prestataire bancaire.

Les règles existantes comptabilisent net + taxe d'achat en coût sur `purchases`, avec contrepartie `payables`, puis règlement via `cash`. Les comptes sont imposés côté serveur. Il n'y a ni TVA suisse récupérable, détermination d'exonération, calcul de use tax ou analyse automatique de conformité. Les montants/source sont des faits saisis et approuvés manuellement, pas la preuve vérifiée d'un document original. Ingestion Support/Automation, devises étrangères, comptes arbitraires, avoirs fournisseurs et exécution bancaire restent hors de cette tranche.

## Contrats, routes et invariants

Prévoir `consumer: financial-pilot`, `schemaVersion: 1`, requestId UUID, expectedRevision et une commande de présentation parmi les trois intentions. Ne pas ouvrir le contrat ERP5 privé. Le navigateur ne fournit ni organisation, currency, compte, approvalSource/acteur/time, rôle, policy ou total. Dériver les IDs de création depuis UUID (`pilot-vendor:`, `pilot-vendor-bill:`, `pilot-vendor-payment:`) et la clé `pilot:purchasing:<UUID>`. La création doit refuser une collision d'ID ; l'édition exige un fournisseur existant. Un reçu historique exact prime sur les changements ultérieurs de source.

Routes prévues sous `/financial-pilot` : POST `/purchasing/operations`, GET `/vendor-bills?revision&cursor`, GET `/vendor-bills/[billId]?revision&paymentCursor`, GET `/vendors/[vendorId]?revision`. Réutiliser les listes de fournisseurs/périodes, le head, le snapshot et les rapports existants. Ajouter des validateurs de pages/cursors explicitement bornés et liés au type/révision/scope : le contrat actuel ferme son union de kinds, donc aucun cast ne peut y ajouter silencieusement un nouveau type. Retourner seulement les DTO publics et des reçus liés à la demande/action/entité/révision.

Réutiliser Auth/D1, droits Gestion, rôle owner/admin/accountant, configuration US/USD/accrual, opt-in/grant TEST vivants, cookies same-origin et fences du pilote. Vérifier la fraîcheur du head avant retour des détails. Le CAS et les gardes existantes contrôlent périodes, doublons de facture, montants et soldes. Ne pas ajouter silencieusement une contrainte paymentDate >= billDate : elle n'existe pas actuellement. La taxe et les références restent dans le hash de la commande capturée.

Le verrou navigateur doit couvrir achats, paiements clients, commerce et émission de facture. Conserver les brouillons pendant polling/changement d'onglet. Une nouvelle révision impose lecture/revue explicite des informations courantes sans remplacer les montants. Un résultat inconnu garde la requête sérialisée et son requestId exacts ; les HTTP 409 postflight ne prouvent pas l'absence de commit. Un retrait d'accès ferme/efface le contenu privé sans repli ERP4. La reprise en RAM reste identifiée comme telle.

## Fichiers et interface prévus

Nouveaux modules `us-financial-pilot-purchasing*` pour contrat, projections, serveur/binding et tests ; routes décrites ci-dessus ; session navigateur partagée, saisie monétaire exacte, copy FR/DE/IT/EN et surface achats dédiée. L'intégration reste dans `us-financial-pilot.tsx` et son menu Fournisseurs. Préserver le monde Operate existant, les tokens account, les thèmes et le mobile ; séparer registre, détail, saisie/revue et règlement avec des actions explicites, sans montrer les données privées. Pas de refonte globale, nouvelle palette, raster, police ou affirmation marketing.

## Vérification et livraison prévues

Tester les DTO fermés/getters/captures, montants et IDs serveur ; fournisseur → facture avec taxe non nulle → règlements partiel/final sur le même livre ; snapshot fournisseur immuable ; création/édition/collision ; doublons, surpaiement, périodes, état corrompu et isolation des espaces/rôles. Tester priorité du reçu exact après source changée, vraie commande committée suivie d'un HTTP 409, échec postflight et retry sans doublon. Les références manuelles et limites fiscales doivent être visibles, sans prétention de document vérifié.

Exécuter la chaîne actuelle de 33 migrations et les vrais wrappers du pilote, avec facture client déjà présente, deux sessions synthétiques, CAS et fermeture/réouverture NodeFS. PGlite sérialisé ne constitue pas une preuve multiconnexion, charge, crash, SLA ou hébergement. Tester pagination au-delà de 25 fournisseurs/factures/paiements, détails sélectionnés au-delà de la première page, transport vers les routes réelles, brouillons/revue de solde et mise à jour automatique du second client local.

Puis régression conservant les 181 fichiers précédents, TypeScript global, lint typé ciblé, marque et build sur sources figées. Recette visuelle groupée FR/DE/IT/EN, clair/sombre, ordinateur/mobile et 320 px, au plus une correction groupée puis confirmation, revue indépendante et documentation. Fournir les huit rubriques de livraison avec empreintes, vrais résultats et limites. Aucune modification hébergée/destructive ou publication n'est autorisée par ce plan ; si un gap de persistance exige une nouvelle migration, réviser explicitement le plan avant de l'écrire.
