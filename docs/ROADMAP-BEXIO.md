# Feuille de route fonctionnelle Zentra

État de la comparaison : 1er septembre 2026. Version source documentée : Zentra 1.13.

Cette feuille de route compare Zentra aux fonctions officiellement documentées par Bexio. Elle ne vise pas à copier son interface ni son architecture cloud : Zentra reste une application Windows locale, avec les données conservées chez le client.

La matrice détaillée et l'ordre produit retenu sont documentés dans
[`BENCHMARK-BEXIO-2026.md`](./BENCHMARK-BEXIO-2026.md).

## Principes produit

- Une seule action principale par écran et des termes compréhensibles sans formation comptable.
- Les devis, factures et pièces émises sont des instantanés : modifier un client ou un produit ne change jamais un ancien document.
- Les automatisations financières restent explicables, annulables et journalisées.
- Une fonction réglementée n'est annoncée conforme qu'après validation indépendante. Zentra ne revendique aucune certification ou homologation AFC, Swissdec/ELM ou Olico.
- Les connexions externes sont optionnelles. Le fonctionnement local et les sauvegardes restent prioritaires.

## Couverture et ordre de réalisation

| Lot | Fonctions attendues | État |
| --- | --- | --- |
| Socle local | installation Windows, configuration guidée, SQLite locale, sauvegardes, audit, mises à jour signées | Disponible ; guide relançable et updater avec reprise guidée en 1.10 ; Authenticode reste à acquérir |
| Vente essentiel | clients, devis, acceptation, conversion en facture, facture QR, avoir, paiements, relances | Disponible ; PDF A4 natifs devis/factures depuis l’instantané figé, QR vectoriel, logo et identité figés, paiement relié à une écriture active revalidée ; automatisation d'envoi à compléter |
| Catalogue et stock | produits/services, prix, TVA, coûts, remises, stock minimal, mouvements, ajout aux devis/factures | Disponible : registre local immuable, réservation à la confirmation d'une commande de vente, sortie à l'émission du BL et entrée à l'émission d'une réception fournisseur ; l'extourne de la réception crée le mouvement inverse. Emplacements à venir |
| Achats | fournisseurs, commandes, réceptions, factures et avoirs fournisseurs, justificatifs, rapprochement, échéances et paiements | Disponible : commande → réception partielle/complète → facture → rapprochement → paiement/comptabilité, avec avoir distinct imputable à une facture. Une facture se rapproche actuellement d'une seule commande ; multi-commandes et OCR des achats à venir |
| Banque locale | import CAMT.053/054, dédoublonnage, propositions de rapprochement, validation humaine | Disponible pour les crédits clients et débits fournisseurs ; périmètre détaillé ci-dessous |
| Cycle commercial avancé | commande, bulletin de livraison, acomptes/partielles, récurrence | Devis avec produits → commandes, BL partiels/complets et situations/finales par quantités ; prestations simples en facture directe ; récurrence supervisée locale en 1.11 ; acomptes libres à venir |
| Comptabilité et TVA | journal, grand livre, balance, résultat, bilan, journal TVA et clôture explicable | Disponible dans le périmètre 1.9 : profils et calcul TVA contrôlés, XML eCH-0217 v2.0.0 local, pré-clôture et dossier fiduciaire DRAFT/FINAL ; aucune transmission ni certification AFC/Olico |
| Projets et temps | projets/chantiers, tâches, temps, coûts, rentabilité, temps vers facture | Projets, tâches, jalons, responsables, échéances, temps, coûts, rentabilité et temps approuvés vers facture disponibles |
| Paie suisse | employés, cotisations versionnées, fiches, import OCR local des documents de paie, écritures | Analyse locale multipage à double lecture, document hashé, provenance par occurrence, file reprenable et confirmation humaine en 1.13 ; Swissdec/ELM non certifié |
| Collaboration | rôles locaux, accès fiduciaire, verrouillage, journal d'audit | Verrouillage de période et audit disponibles ; rôles locaux et accès fiduciaire simultané planifiés |
| Écosystème | API locale, connecteurs isolés, compagnon mobile | Ultérieur |

## Périmètre achats de Zentra 1.8

- Une commande fournisseur est préparée en brouillon puis confirmée avec ses lignes, quantités, prix, TVA, comptes de charge et, le cas échéant, projet et article de catalogue.
- Une commande ouverte accepte une ou plusieurs réceptions partielles ou une réception complète. Le brouillon ne touche jamais le stock : seule l'émission d'une réception crée une entrée pour les produits suivis. Son extourne motivée conserve l'historique et crée la sortie inverse.
- Une facture fournisseur peut être autonome ou rapprochée des lignes d'une commande et de ses réceptions émises. Zentra contrôle alors les quantités, les montants nets et la TVA avant validation.
- Une facture ne peut actuellement être rapprochée qu'avec une seule commande fournisseur. Le rapprochement d'une facture couvrant plusieurs commandes est un lot futur.
- Un avoir fournisseur est un document comptable distinct : il peut être validé et imputé à une facture, puis cette imputation peut être extournée avec traçabilité. Il réduit le solde restant, mais ne remplace pas la facture dans le rapprochement commande-réception-facture et ne crée aucun mouvement de stock.
- La validation, le paiement manuel ou bancaire confirmé et les écritures comptables restent des opérations distinctes et auditables. Ni la facture, ni l'avoir, le rapprochement, le paiement ou la comptabilisation ne modifient le stock.
- Aucun OCR d'achats n'est livré en 1.8. L'OCR local existant est réservé à l'import de documents de paie.

## Périmètre bancaire local de Zentra 1.8

- Import sur le PC de relevés suisses `camt.053` et `camt.054` dans les versions `v04` et `v08`. Le fichier XML brut n'est pas envoyé à Zentra ni à un service tiers.
- Détection des doublons d'import et conservation locale de l'historique utile au contrôle.
- Association explicite d'un compte bancaire importé à un IBAN ou QR-IBAN de l'entreprise. Cette association reste visible et peut être révoquée.
- Proposition de factures clientes standard, d'acompte historique, de situation ou finales à partir de références structurées QRR ou SCOR, et de factures fournisseurs pour les débits compatibles. Une date bancaire antérieure à l'émission de la facture bloque la confirmation ; Zentra n'enregistre aucun paiement sans confirmation humaine.
- Rapprochement limité aux crédits clients ou débits fournisseurs portant sur des pièces comptabilisées ou validées, non annulées, dans la devise attendue et sans dépassement du solde restant de la facture après avoirs imputés.
- Les écritures en attente, annulations, lots ambigus et montants excédentaires restent visibles pour contrôle, mais ne sont pas rapprochés automatiquement.
- Les connexions bancaires directes, règles personnalisées, ordres pain.001 et écritures de frais bancaires restent à venir.

Cette portée volontairement bornée évite de présenter une lecture bancaire comme une comptabilisation certaine. Les mouvements importés, les liens de comptes, la décision de l'utilisateur et l'écriture résultante restent dans la base SQLite locale et ses sauvegardes.

## Périmètre TVA de Zentra 1.9

- Un profil daté conserve la méthode réellement appliquée : méthode effective ou TDFN/TaF (`simpleTaxRateMethod`), contre-prestations convenues ou reçues, périodicité et présentation brute ou nette selon le cas. Une nouvelle version ne réécrit pas les périodes antérieures.
- Le centre TVA prépare les chiffres utiles du décompte à partir des écritures locales. Les sources ambiguës ou non classées restent visibles et bloquent l'export : Zentra ne devine pas leur traitement fiscal.
- Les ajustements sont journalisés. Une correction n'efface pas l'original : elle est extournée explicitement afin de conserver l'historique.
- L'aperçu présente notamment les chiffres 200, 299 et le montant dû ou l'avoir estimé aux chiffres 500/510, avec le détail par taux ou activité. L'utilisateur reste responsable de la vérification des catégories, autorisations et justificatifs.
- Zentra génère localement un fichier XML eCH-0217 v2.0.0 destiné à l'import **manuel** dans Décompte TVA pro. Le logiciel n'effectue aucune transmission à l'AFC et ne garantit ni l'acceptation du fichier, ni l'exactitude du décompte final, ni une certification. L'utilisateur vérifie, complète et soumet dans le Portail AFC.

## Périmètre clôture et dossier fiduciaire de Zentra 1.9

- La clôture suit deux étapes : Zentra prépare d'abord une revue figée, affiche les contrôles et calcule une empreinte SHA-256; l'utilisateur peut ensuite faire vérifier le dossier avant de verrouiller définitivement la période.
- Toute modification d'une écriture, d'une pièce ou d'un réglage pertinent invalide la revue précédente. Une clôture définitive exige une revue encore valable et une confirmation explicite du nom de la période.
- Avant le verrouillage, l'export produit un dossier `DRAFT`. Après le verrouillage de la même période et sur la même empreinte, il produit un dossier `FINAL` comprenant les états comptables, index de pièces, audit, manifeste et fichier `SHA256SUMS`.
- `FINAL` décrit uniquement l'état verrouillé dans Zentra. Il ne signifie pas que la fiduciaire, l'AFC ou une autre autorité a approuvé les comptes.
- Ces fonctions soutiennent une organisation et une conservation orientées CO/Olico, mais Zentra n'est pas « certifié Olico ». La conformité dépend également des procédures internes, droits d'accès, supports de conservation, sauvegardes, migrations et contrôles de l'entreprise.

## Périmètre des factures récurrentes de Zentra 1.11

- Depuis un devis de service accepté, l'utilisateur choisit une facture unique ou une commande modèle. Une planification n'est autorisée que sur une commande confirmée en CHF, composée uniquement de prestations directes, sans stock, livraison, facturation standard ou quantité annulée.
- Le rythme mensuel, trimestriel ou annuel, la première échéance, la date de fin facultative et le délai de paiement sont figés avec une empreinte SHA-256. Modifier ensuite le client, les réglages ou le catalogue ne réécrit pas ce modèle.
- Au démarrage, au retour au premier plan et toutes les cinq minutes tant qu'Zentra est ouvert, le moteur local traite les échéances dues. Chaque occurrence crée uniquement une facture brouillon indépendante : aucun numéro, QR-facture, envoi, mouvement de stock ou écriture comptable n'est produit automatiquement.
- Après une période hors ligne, un lancement prépare au maximum douze brouillons. S'il reste des échéances, la planification passe en revue obligatoire; l'utilisateur reprend explicitement le lot suivant.
- Pause, reprise et fin définitive sont journalisées et idempotentes. Une commande utilisée comme modèle ne peut jamais réintégrer le flux livraison/facturation standard, afin d'éviter une double facturation. Les occurrences et la planification restent conservées pour la traçabilité.

## Périmètre documentaire et paie de Zentra 1.13

- Les devis et factures sont exportés par le moteur natif de l’application en A4. Un document émis est rendu depuis son instantané figé; une identité, un destinataire, un logo ou des montants finaux manquants ou incohérents bloquent l’export au lieu d’être reconstruits silencieusement.
- La section QR d’une facture utilise le payload SPC enregistré, régénéré et comparé avant export. Le code est vectoriel, en correction d’erreur M, dimensionné à 46 mm, avec symbole suisse et zone libre; il n’apparaît que sur la dernière page. Cette implémentation doit encore passer une validation externe avant toute revendication de certification.
- Les documents de paie PDF ou image sont copiés dans le stockage géré, hashés en SHA-256 et relus depuis ces mêmes octets. Les aperçus, mises à jour d’analyse et confirmations revérifient le hash; une altération bloque le parcours.
- SmolVLM fonctionne localement en deux lectures par lot de pages. Zentra conserve les occurrences répétées, rattache les indications aux pages et remplace les anciennes propositions IA lors d’une relance sans écraser les corrections humaines.
- Une rubrique salariale récurrente exige une case cochée explicitement. Le brut historique d’une fiche ne devient jamais à lui seul un modèle salarial. Les cotisations et le rattachement au collaborateur restent soumis aux contrôles déterministes et à la confirmation finale.

## Références officielles consultées

- Fonctions : https://www.bexio.com/fr-CH/fonctions
- CRM : https://www.bexio.com/fr-CH/crm
- Facturation : https://www.bexio.com/fr-CH/logiciel-de-facturation
- Processus de vente et dépenses : https://www.bexio.com/fr-CH/gestion-des-processus-de-vente-et-des-depenses
- Achats et dépenses : https://www.bexio.com/fr-CH/gestion-des-depenses
- Comptabilité : https://www.bexio.com/fr-CH/logiciel-de-comptabilite-pme
- Paie : https://www.bexio.com/fr-CH/comptabilite-salaire
- Stock : https://www.bexio.com/fr-CH/gestion-des-stocks-pme
- Projets : https://www.bexio.com/fr-CH/logiciel-de-gestion-projet
- ISO 20022 : https://www.bexio.com/fr-CH/iso20022
- API : https://docs.bexio.com/
- Comparatif des forfaits du 28 mai 2026 : https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf
- AFC, taux de la TVA suisse : https://www.estv.admin.ch/fr/taux-de-la-tva-suisse
- eCH-0217 v2.0.0, Décompte TVA : https://www.ech.ch/fr/ech/ech-0217/2.0.0
- Loi fédérale régissant la TVA (LTVA) : https://www.fedlex.admin.ch/eli/cc/2009/615/fr
- Ordonnance régissant la TVA (OTVA) : https://www.fedlex.admin.ch/eli/cc/2009/828/fr
- Code des obligations (CO) : https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr
- Ordonnance concernant la tenue et la conservation des livres de comptes (Olico) : https://www.fedlex.admin.ch/eli/cc/2002/216/fr
- SECO, conservation électronique des livres de comptes : https://www.kmu.admin.ch/fr/conservation-electronique-des-livres-de-comptes
- SIX, Swiss Payment Standards 2026 — Implementation Guidelines for Cash Management : https://www.six-group.com/dam/download/banking-services/standardization/sps/ig-cash-management-sps-2026-en.pdf
- SIX, Swiss Payment Standards 2026 — Business Rules : https://www.six-group.com/dam/download/banking-services/standardization/sps/business-rules-sps-2026-en.pdf
- SIX, standardisation des paiements suisses : https://www.six-group.com/en/products-services/banking-services/payment-standardization/swiss-payments.html
- SIX, norme ISO 20022 : https://www.six-group.com/en/products-services/banking-services/payment-standardization/standards/iso-20022.html

## Prochains lots, dans l'ordre

1. Étendre le rapprochement fournisseur à une facture couvrant plusieurs commandes et ajouter un OCR d'achats avec contrôle humain.
2. Ajouter les acomptes de vente définis par montant ou pourcentage, avec imputation explicite sur la facture finale.
3. Ajouter les modèles multilingues et l'envoi de documents ou relances explicitement configuré par le client; la récurrence supervisée est disponible depuis 1.11.
4. Étendre les pièces liées aux écritures et préparer un échange fiduciaire chiffré, sans transformer cet échange en synchronisation implicite.
5. Ajouter import/export de contacts, catégories, rôles locaux et accès fiduciaire contrôlé.

Swissdec/ELM reste un programme de certification distinct : Zentra doit continuer à se présenter comme une aide locale à la préparation et au contrôle de la paie tant que cette certification n'est pas obtenue. Le XML eCH-0217 est un export local pour import manuel et ne constitue ni une transmission ni une certification AFC. Le dossier DRAFT/FINAL et ses empreintes SHA-256 soutiennent le contrôle et la conservation, sans constituer une certification Olico.
