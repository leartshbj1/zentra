# Feuille de route fonctionnelle Zentra

État de la comparaison : 2 septembre 2026. Version source documentée : future Zentra 1.18.0, sans publication annoncée.

Cette feuille de route compare Zentra aux fonctions officiellement documentées par Bexio. Elle ne vise pas à copier son interface ni son architecture cloud : Zentra reste une application locale Windows et macOS. La base métier active reste chez le client ; le compte, les droits d’accès et l’archivage volontaire des PDF de factures utilisent un service Zentra limité.

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
| Socle local | installation Windows et macOS, configuration guidée, SQLite locale, sauvegardes, audit, mises à jour signées | Source Windows et cible macOS universelle disponibles ; onboarding progressif après confirmation de l'identité et de l'activité, puis checklist 1.18 calculée exclusivement depuis les vraies données locales ; logo importé dans le stockage local géré et référencé par hash en 1.17 ; identité visuelle Zentra et migration de l'ancienne installation Windows conservant les données ; guide relançable et updater avec reprise guidée en 1.10. Le DMG public attend encore build, signature et notarisation sur un Mac ; Authenticode reste à acquérir pour Windows |
| Vente essentiel | clients, devis, acceptation, conversion en facture, facture QR, avoir, paiements, relances | Disponible ; PDF A4 natifs devis/factures depuis l’instantané figé, QR vectoriel, logo et identité figés, paiement relié à une écriture active revalidée ; aucun envoi automatique réel des relances n'est livré |
| Catalogue et stock | produits/services, prix, TVA, coûts, remises, stock minimal, mouvements, ajout aux devis/factures | Disponible : registre local immuable, réservation à la confirmation d'une commande de vente, sortie à l'émission du BL et entrée à l'émission d'une réception fournisseur ; l'extourne de la réception crée le mouvement inverse. Emplacements à venir |
| Achats | fournisseurs, commandes, réceptions, factures et avoirs fournisseurs, justificatifs, rapprochement, échéances et paiements | Disponible : commande → réception partielle/complète → facture → rapprochement multi-commandes → paiement/comptabilité, avec tolérance globale, protection des ventilations et avoir distinct imputable à une facture ; OCR des achats non livré |
| Banque locale | import CAMT.053/054, dédoublonnage, propositions de rapprochement, validation humaine | Disponible pour les crédits clients et débits fournisseurs ; périmètre détaillé ci-dessous |
| Cycle commercial avancé | commande, bulletin de livraison, acomptes/partielles, récurrence | Devis avec produits → commandes, BL partiels/complets et situations/finales par quantités ; prestations simples en facture directe ; récurrence supervisée locale en 1.11 ; acomptes libres à venir |
| Comptabilité et TVA | journal, grand livre, balance, résultat, bilan, journal TVA et clôture explicable | Disponible : profils et calcul TVA contrôlés, XML eCH-0217 v2.0.0 local, pré-clôture et dossier fiduciaire DRAFT/FINAL ; en 1.18, la dernière clôture scelle cumulativement toute date antérieure ou égale, tout en autorisant les seuls replays strictement identiques et les corrections postérieures référencées ; aucune transmission ni certification AFC/Olico |
| Projets et temps | projets/chantiers, tâches, agenda, temps, coûts, rentabilité, temps vers facture | Projets, tâches, jalons, responsables, échéances, agenda jour/semaine/mois, rendez-vous locaux, temps, coûts, rentabilité et temps approuvés vers facture disponibles |
| Paie suisse | employés, cotisations versionnées, fiches, import OCR local des documents de paie, écritures | Analyse locale multipage, manifeste d'audit v2, rapprochement salarié Unicode et confirmation humaine ; PDF A4 professionnel ; date réglementaire, arrondi au CHF 0.05, garde LPP 2026 et contrôles AAP/AANP/CAF ; en 1.18, régime des salaires de minime importance dérivé du cumul annuel, avec décision/preuve/trace locale et rattrapage contrôlé ; QST autonome, moteur LPP multiannuel complet, IJM structurée, certificat annuel, ELM et certification Swissdec non livrés |
| Collaboration | compte d’entreprise, rôles, accès fiduciaire, appareils, verrouillage, journal d'audit | Compte serveur et invitations sans limite de sièges ; rôles propriétaire, administrateur, comptable, collaborateur et lecture seule ; révocation des sessions/appareils ; verrouillage de période et audit local. Les données métier SQLite ne sont pas synchronisées en temps réel entre appareils |
| Écosystème | API locale, connecteurs isolés, compagnon mobile | Ultérieur |

## Périmètre du démarrage progressif de Zentra 1.15, complété en 1.18 source

- L'utilisateur peut créer son espace après avoir confirmé l'identité de l'entreprise et son domaine d'activité, ou poursuivre immédiatement la configuration complète.
- En parcours progressif, les valeurs techniques proposées pour la facturation, le temps/coûts et la sauvegarde restent marquées comme non confirmées dans le centre de préparation. Elles ne sont pas présentées comme des choix de l'utilisateur.
- Les flux de devis/factures et de temps restent bloqués tant que leur groupe de réglages n'a pas été enregistré explicitement. La sauvegarde reste incomplète jusqu'à la confirmation de sa stratégie et à une première archive réussie.
- La checklist 1.18 ne crée aucune donnée et ne contient aucune case de réussite arbitraire. Elle observe six preuves persistées : un client actif, un projet rattaché à un client actif, un devis numéroté et accepté pour ce client, une facture numérotée et émise depuis ce devis, un paiement positif rattaché à cette facture et à une écriture active cohérente, puis une sauvegarde réellement créée avec son chemin et sa date.
- Tant que l'une de ces preuves manque ou devient invalide, l'étape correspondante reste incomplète. Une fois les six preuves réunies, la checklist disparaît sans remplacer les données métier par un état synthétique.

## Périmètre achats de Zentra 1.8, étendu en 1.15 source

- Une commande fournisseur est préparée en brouillon puis confirmée avec ses lignes, quantités, prix, TVA, comptes de charge et, le cas échéant, projet et article de catalogue.
- Une commande ouverte accepte une ou plusieurs réceptions partielles ou une réception complète. Le brouillon ne touche jamais le stock : seule l'émission d'une réception crée une entrée pour les produits suivis. Son extourne motivée conserve l'historique et crée la sortie inverse.
- Une facture fournisseur peut être autonome ou rapprochée des lignes d'une ou plusieurs commandes confirmées compatibles et de leurs réceptions émises. Toutes les commandes doivent correspondre au fournisseur et à la devise de la facture, et ne peuvent pas être postérieures à celle-ci.
- Le rapprochement multi-commandes est enregistré atomiquement. Zentra contrôle les quantités et les montants HT, TVA et TTC ligne par ligne, puis applique à l'ensemble de la facture une tolérance maximale d'un centime pour chacun de ces totaux : la tolérance ne se multiplie pas avec le nombre de commandes.
- Une ligne déjà ventilée sur plusieurs commandes ne peut pas être écrasée silencieusement par l'éditeur. Il faut retirer explicitement le rapprochement existant avant de le remplacer ; une tentative invalide conserve les allocations précédentes.
- Un avoir fournisseur est un document comptable distinct : il peut être validé et imputé à une facture, puis cette imputation peut être extournée avec traçabilité. Il réduit le solde restant, mais ne remplace pas la facture dans le rapprochement commande-réception-facture et ne crée aucun mouvement de stock.
- La validation, le paiement manuel ou bancaire confirmé et les écritures comptables restent des opérations distinctes et auditables. Ni la facture, ni l'avoir, le rapprochement, le paiement ou la comptabilisation ne modifient le stock.
- Aucun OCR d'achats n'est livré, y compris dans la future source 1.18.0. L'OCR local existant est réservé à l'import de documents de paie. Le socle expérimental d'analyse des factures fournisseurs n'est relié ni à l'interface, ni à la base, ni au moteur comptable et ne doit pas être présenté comme une fonction disponible.

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

## Périmètre clôture et dossier fiduciaire de Zentra 1.9, renforcé en 1.18 source

- La clôture suit deux étapes : Zentra prépare d'abord une revue figée, affiche les contrôles et calcule une empreinte SHA-256; l'utilisateur peut ensuite faire vérifier le dossier avant de verrouiller définitivement la période.
- Toute modification d'une écriture, d'une pièce ou d'un réglage pertinent invalide la revue précédente. Une clôture définitive exige une revue encore valable et une confirmation explicite du nom de la période.
- À partir de 1.18, la borne de protection est cumulative : toute opération datée au plus tard à la date de fin de la dernière période définitivement clôturée est scellée, même si un intervalle antérieur n'a pas fait l'objet d'une clôture distincte. La même règle protège les sources du journal et de la TVA contre une insertion, modification, suppression ou configuration historique rétroactive.
- Un rejeu strictement identique reste accepté pour rendre les commandes idempotentes. Un rejeu divergent ou antidaté est refusé sans consommer de numéro, créer d'écriture ou modifier l'audit et les preuves de clôture. Une correction ou extourne légitime est enregistrée après la borne scellée et référence l'opération d'origine au lieu de la réécrire.
- Avant le verrouillage, l'export produit un dossier `DRAFT`. Après le verrouillage de la même période et sur la même empreinte, il produit un dossier `FINAL` comprenant les états comptables, index de pièces, audit, manifeste et fichier `SHA256SUMS`.
- `FINAL` décrit uniquement l'état verrouillé dans Zentra. Il ne signifie pas que la fiduciaire, l'AFC ou une autre autorité a approuvé les comptes.
- Ces fonctions soutiennent une organisation et une conservation orientées CO/Olico, mais Zentra n'est pas « certifié Olico ». La conformité dépend également des procédures internes, droits d'accès, supports de conservation, sauvegardes, migrations et contrôles de l'entreprise.

## Périmètre des factures récurrentes de Zentra 1.11

- Depuis un devis de service accepté, l'utilisateur choisit une facture unique ou une commande modèle. Une planification n'est autorisée que sur une commande confirmée en CHF, composée uniquement de prestations directes, sans stock, livraison, facturation standard ou quantité annulée.
- Le rythme mensuel, trimestriel ou annuel, la première échéance, la date de fin facultative et le délai de paiement sont figés avec une empreinte SHA-256. Modifier ensuite le client, les réglages ou le catalogue ne réécrit pas ce modèle.
- Au démarrage, au retour au premier plan et toutes les cinq minutes tant qu'Zentra est ouvert, le moteur local traite les échéances dues. Chaque occurrence crée uniquement une facture brouillon indépendante : aucun numéro, QR-facture, envoi, mouvement de stock ou écriture comptable n'est produit automatiquement.
- Après une période hors ligne, un lancement prépare au maximum douze brouillons. S'il reste des échéances, la planification passe en revue obligatoire; l'utilisateur reprend explicitement le lot suivant.
- Pause, reprise et fin définitive sont journalisées et idempotentes. Une commande utilisée comme modèle ne peut jamais réintégrer le flux livraison/facturation standard, afin d'éviter une double facturation. Les occurrences et la planification restent conservées pour la traçabilité.

## Périmètre documentaire et paie de Zentra 1.13, complété en 1.18 source

- Les devis et factures sont exportés par le moteur natif de l’application en A4. Un document émis est rendu depuis son instantané figé; une identité, un destinataire, un logo ou des montants finaux manquants ou incohérents bloquent l’export au lieu d’être reconstruits silencieusement.
- La section QR d’une facture utilise le payload SPC enregistré, régénéré et comparé avant export. Le code est vectoriel, en correction d’erreur M, dimensionné à 46 mm, avec symbole suisse et zone libre; il n’apparaît que sur la dernière page. Cette implémentation doit encore passer une validation externe avant toute revendication de certification.
- Les documents de paie PDF ou image sont copiés dans le stockage géré, hashés en SHA-256 et relus depuis ces mêmes octets. Les aperçus, mises à jour d’analyse et confirmations revérifient le hash; une altération bloque le parcours.
- Le modèle SmolVLM générique fonctionne localement en deux lectures par lot de pages ; il n'est pas présenté comme un modèle suisse certifié ou spécialement fine-tuné par Zentra. Quand un PDF contient du texte, une corroboration déterministe supplémentaire lie les champs proposés aux pages et aux occurrences imprimées. Le manifeste v2 conserve la méthode, l'algorithme et des scores prudents ; une image ne peut pas prétendre avoir utilisé une couche texte PDF.
- Zentra conserve les occurrences répétées, remplace les anciennes propositions IA lors d’une relance sans écraser les corrections humaines et rapproche les noms Unicode sans réduire les identités non latines à une chaîne vide. Un doublon probable bloque la création automatique et exige un choix humain.
- Une rubrique salariale récurrente exige une case cochée explicitement. Le brut historique d’une fiche ne devient jamais à lui seul un modèle salarial. Les cotisations et le rattachement au collaborateur restent soumis aux contrôles déterministes et à la confirmation finale.
- La date de paiement renseignée avant le calcul sélectionne la fenêtre de validité des taux, franchises et plafonds de cotisations, tandis que l'âge et l'assujettissement restent rattachés à la période travaillée. Sans date connue au stade du brouillon, le calcul utilise explicitement le premier jour de la période. Une fiche comptabilisée refuse ensuite une date réelle qui sortirait du millésime ou d'une fenêtre réglementaire figée ; elle doit être extournée et recalculée.
- Chaque cotisation calculée par taux est arrondie commercialement au CHF 0.05. Les montants fixes configurés restent inchangés.
- Pour la LPP 2026, Zentra contrôle le seuil légal, le salaire coordonné, l'âge, la durée du contrat et les exceptions documentées. Les lignes de cotisation doivent provenir du règlement réellement enregistré, être rattachées au bon salarié et distinguer risque, épargne ou combinaison. La période du plan et la confirmation de la part patronale globale sont obligatoires ; Zentra n'invente aucun taux et ne transforme pas les bonifications légales en retenues universelles.
- Pour l'AAP/AANP, le taux positif, l'assiette AVS ou personnalisée documentée, la source de police, le côté et le plafond 2026 sont contrôlés. Une fiche exige exactement une ligne AAP et, dès que le seuil de huit heures est atteint, exactement une ligne AANP ; les doublons et l'AANP non applicable sont refusés. L'ouverture annuelle LAA est confirmée sur le salarié, le plafond est proratisé selon la période d'emploi 30/360 et le cumul est ensuite dérivé des fiches locales antérieures ; une valeur transmise par l'interface ne peut pas le remplacer. Pour la CAF, Zentra exige le canton, la caisse, un taux documenté sur salaire AVS sans plafond libre et encadre séparément la part salarié Valais 2026 à 0,13 %.
- En 1.18, le régime des salaires de minime importance est une décision annuelle documentée par emploi et employeur. Dans le secteur ordinaire, un cumul ne dépassant pas CHF 2'500 est exonéré d'AVS/AI/APG/AC sauf demande du salarié ; le dépassement rend cotisant l'ensemble du salaire annuel et Zentra dérive la base antérieure à rattraper. Ce régime ne se cumule pas avec la franchise AVS accordée après l'âge de référence. Dans un ménage privé, seule la personne couverte jusqu'au 31 décembre de l'année de ses 25 ans peut bénéficier du seuil de CHF 750 ; au-delà de l'âge ou du seuil, les cotisations sont obligatoires. Les activités artistiques et culturelles visées sont toujours cotisantes.
- Le cumul combine une ouverture annuelle explicitement justifiée et les fiches locales antérieures validées, comptabilisées ou payées ; aucune valeur cumulative libre transmise par l'interface ne remplace ce calcul. La date de décision et sa référence probante sont conservées avec une trace locale immuable du calcul. Une demande du salarié formulée après des salaires déjà versés agit prospectivement et ne provoque pas, à elle seule, de rattrapage rétroactif ; une décision ayant déjà servi à prélever ne peut pas être retirée rétroactivement.
- Hors ménages privés et activités artistiques/culturelles obligatoirement cotisantes, l'exception LAA liée aux seuls salaires minimes n'est activable qu'après confirmation et preuve annuelles que tous les salariés concernés pendant l'année — y compris ceux partis ou devenus inactifs — remplissent les conditions. Au moindre cas incompatible, le contrôle ordinaire de la police AAP reste exigé. Ce garde-fou local ne remplace ni la décision de l'assureur ou de la caisse, ni un conseil fiduciaire.
- L'IJM reste volontairement marquée incomplète tant que le régime, le numéro de police, la couverture, le délai d'attente, la durée des prestations et la répartition ne sont pas structurés. Le calcul autonome de l'impôt à la source (QST), un moteur LPP complet couvrant tous les règlements et millésimes, le certificat annuel/formulaire 11, la génération ou transmission ELM et la certification Swissdec ne sont pas livrés. Ces fonctions d'aide locale ne constituent ni une validation de conformité globale, ni une certification.

## Références officielles consultées

- Fonctions : https://www.bexio.com/fr-CH/fonctions
- CRM : https://www.bexio.com/fr-CH/crm
- Facturation : https://www.bexio.com/fr-CH/logiciel-de-facturation
- Processus de vente et dépenses : https://www.bexio.com/fr-CH/gestion-des-processus-de-vente-et-des-depenses
- Achats et dépenses : https://www.bexio.com/fr-CH/gestion-des-depenses
- Comptabilité : https://www.bexio.com/fr-CH/logiciel-de-comptabilite-pme
- Paie : https://www.bexio.com/fr-CH/comptabilite-salaire
- AVS/AI — mémento 2.04, cotisations sur les salaires minimes : https://www.ahv-iv.ch/Portals/0/Documents/Merkblaetter/Gruppe_2/2.04_f.pdf
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

1. Relier à l'interface, au stockage local et au moteur comptable un OCR des factures et avoirs fournisseurs avec double lecture, rapprochement explicite et contrôle humain ; le rapprochement multi-commandes est déjà implémenté dans la source 1.17.
2. Ajouter les acomptes de vente définis par montant ou pourcentage, avec imputation explicite sur la facture finale.
3. Ajouter les modèles multilingues et l'envoi automatique réel de documents ou relances explicitement configuré par le client ; la récurrence supervisée est disponible depuis 1.11, mais aucun message ne part seul aujourd'hui.
4. Étendre les pièces liées aux écritures et préparer un échange fiduciaire chiffré, sans transformer cet échange en synchronisation implicite.
5. Ajouter import/export de contacts, catégories, rôles locaux et accès fiduciaire contrôlé.

Swissdec/ELM reste un programme distinct et non livré : Zentra ne génère ni ne transmet de déclaration ELM et doit continuer à se présenter comme une aide locale à la préparation et au contrôle de la paie tant qu'une certification n'est pas obtenue. Le calcul QST autonome, le moteur LPP multiannuel complet, le certificat annuel et la modélisation complète des contrats IJM restent également non livrés. Les gardes salaires minimes, LAA et CAF 2026 contrôlent la configuration et les preuves saisies mais ne remplacent pas une décision d'assureur, de caisse ou de fiduciaire. Le XML eCH-0217 est un export local pour import manuel et ne constitue ni une transmission ni une certification AFC. Le dossier DRAFT/FINAL et ses empreintes SHA-256 soutiennent le contrôle et la conservation, sans constituer une certification Olico. Aucun des lots de la future source 1.18.0 ne vaut validation de conformité ou certification.
