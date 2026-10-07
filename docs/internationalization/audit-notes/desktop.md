# Audit desktop — internationalisation CH / US

Date : 7 octobre 2026. Audit statique du checkout `C:/Users/alb/Documents/ChatGPT/chantier`, avant modification majeure. Révision Git observée : `dd64a18c34b44bb4c9d8e4c0a921a3602d3d8944`. Le relevé Git comprend 239 entrées suivies modifiées et 469 entrées non suivies ; le dépôt évolue pendant les audits parallèles. Ces fichiers préexistants ont été conservés.

Seul ce document est écrit par cette mission. Aucun build, test, migration, accès à une base métier, lancement natif, installation ou appel de production n’est exécuté. Aucun `AGENTS.md` n’a été trouvé aux ancêtres du checkout ni dans les périmètres desktop/docs recherchés, y compris par vérification directe des répertoires concernés.

## Conclusion de périmètre

Gestion contient une fondation locale substantielle, avec IPC Tauri, persistance SQLite, états commerciaux, contrôles financiers, instantanés et tests. Elle reste organisée autour d’une entreprise suisse. Changer la langue en anglais ou le pays en `US` ne produit pas une version américaine opérationnelle.

Les blocages dominants sont : devise de configuration forcée à CHF dans le bridge, achats et commandes limités à CHF, IBAN CH/LI obligatoire pour émettre une facture ordinaire, comptabilité limitée à CHF/EUR avec états cumulés en CHF, moteur TVA/eCH suisse et paie suisse. Les PDF et plusieurs formulaires ne sont pas intégralement traduits. Aucun moteur de sales tax US ni profil métier US distinct n’a été identifié dans les modèles et commandes inspectés.

Les manifests desktop déclarent `1.46.1` : `desktop/package.json:3`, `desktop/src-tauri/Cargo.toml:3`, `desktop/src-tauri/tauri.conf.json:5`. Le schéma SQLite courant est 67 (`desktop/src-tauri/src/schema.rs:1`) ; le contrat de synchronisation métier courant est 62 (`desktop/src-tauri/src/business_sync.rs:6`). Ce sont deux versions de contrat différentes, à préserver explicitement. Ce relevé n’assimile pas ce checkout à la copie isolée Notes/frontend 1.90.15 ni à la démo de présentation, qui ne sont pas les sources auditées ici.

| Domaine | Réutilisable | CH bloquant pour un profil US | Absent US dans le périmètre inspecté |
| --- | --- | --- | --- |
| Socle local | IPC typé, transactions SQLite, contraintes, sauvegardes, snapshots et contrats historiques. | Des champs et listes de colonnes métier portent les règles CH ; toute migration doit évoluer avec les contrats de sync. | Profil explicite de marché/juridiction avec capacités séparées. |
| Entreprise | Identité, coordonnées et pays ISO ; préférence de langue indépendante des données. | CHF rétabli par le bridge ; NOGA et IBAN CH/LI à l’onboarding. | EIN/NAICS typés, locale régionale et fuseau métier configurables. |
| Ventes | États commerciaux, lignes, numérotation, snapshots émis et renderer PDF. | Facture ordinaire exige IBAN CH/LI ; commandes/livraisons, récurrence et temps imposent CHF. | Cycle autonome US/USD et politique de paiement/document US. |
| Achats et catalogue | Provenance des pièces, validation humaine, stock et quantités canoniques. | Fournisseur, achats et dépenses CHF ; prix catalogue sans devise propre. | Cycle achats/avoirs USD et modèle de taxes US. |
| Finance | Journaux équilibrés, périodes, rapprochement CAMT, protection contre les mélanges. | Journaux CHF/EUR ; états/clôture en CHF, sans registre de change. | Tenue et rapports USD complets ; adaptateurs bancaires US identifiés et traçables. |
| Fiscalité et paie | Profils datés et preuves de calcul, à conserver pour CH. | TVA eCH/CHE/CHF et cotisations/certificat suisses. | Sales tax US, paie US et déclarations correspondantes. |
| Présentation et agenda | Quatre langues d’interface, unités textuelles et dates civiles. | Plusieurs labels/PDF français, locales CH, A4, heures sans fuseau explicite. | Couverture intégrale anglaise vérifiée, locale US, format Letter et événements multi-fuseaux. |

Les preuves et points d’extension de chaque ligne sont détaillés ci-dessous. « Réutilisable » décrit une base technique existante, sans conclure que son adaptation internationale est déjà faite.

## Lecture des statuts

- **Opérationnel dans le code** : écran/commande et chemin de persistance présents, avec comportements identifiables. Cela ne constitue pas un résultat de recette exécutée aujourd’hui, une preuve de disponibilité en production ou une certification.
- **Partiel** : mécanisme utilisable dans son périmètre existant, avec une limite explicite qui empêche de conclure à la capacité CH/US recherchée.
- **Absent du périmètre inspecté** : aucun modèle, commande ou branche correspondante trouvé lors des recherches ciblées et de la lecture des surfaces critiques. Cette qualification n’affirme pas une lecture de chaque ligne du dépôt.

## Carte des surfaces critiques

| Surface | Preuve existante | État CH / limite US |
| --- | --- | --- |
| Runtime et stockage | `lib.rs:157` initialise `LocalStore`. `database.rs:1463` crée les dossiers locaux et SQLite ; `database.rs:1520` active clés étrangères, WAL et délai d’attente. | Opérationnel dans le code. Le stockage lui-même peut servir aux deux marchés ; son schéma métier reste couplé CH. |
| Configuration de l’entreprise | `types.ts:24`, `types.ts:183`, `models.rs:35`, `schema.rs:262`. Identité, adresse, NOGA, facturation, temps, paie et sauvegarde. | Partiel pour internationalisation : pays à deux lettres, mais pas de marché/juridiction/locale/fuseau métier indépendant. |
| Clients et projets | `types.ts:205`, `types.ts:232`, `schema.rs:302`, `schema.rs:359`, IPC générique `commands.rs:277`. | Opérationnel dans le code. Les champs texte et ISO pays sont réutilisables ; budget/coûts de projet n’ont pas de devise propre. |
| Catalogue et stock | Prix en cents, TVA en points de base et quantités de stock en millièmes (`schema.rs:321`). Commandes stock `commands.rs:406`. | Opérationnel CH, partiel US : prix du catalogue implicitement CHF ; unités libres mais choix et textes par défaut français/métriques. |
| Devis et factures | `schema.rs:381`, `schema.rs:420`, émission `database.rs:3380`, `database.rs:3442`, PDF `commands.rs:1568`. | Opérationnel CH. Devis/factures portent un code devise textuel, mais émission et traitements en aval restent suisses. |
| Commandes et livraisons clients | Conversion et réservation native dans `sales_fulfillment.rs:737`, sauvegarde `sales_fulfillment.rs:835`. | Opérationnel CH ; commandes non-CHF refusées. Une devise libre sur un devis ne garantit pas sa conversion. |
| Factures récurrentes | Snapshot de commande confirmé vérifié dans `recurrence.rs:303`, contrat IPC `recurrenceBridge.test.ts:14`. | Opérationnel CH ; le snapshot source doit être CHF (`recurrence.rs:315`). |
| Temps et facturation | `time_billing.rs:135` crée la facture depuis les heures et conserve leurs preuves. | Opérationnel CH ; devise de la facture écrite en dur à CHF (`time_billing.rs:410`). |
| Achats, fournisseurs, avoirs | IPC spécialisés `commands.rs:446`, `commands.rs:491`, `commands.rs:571`. Contraintes `schema.rs:349`, `schema.rs:732`. | Opérationnel CH ; devise CHF imposée dans les modèles, validations, écritures et compensations. |
| Paiements et rapprochement | Paiement rattaché à la facture (`schema.rs:832`) ; import CAMT et confirmation native (`commands.rs:148`, `commands.rs:187`). | Opérationnel dans le périmètre CAMT. Pas de registre de change ; paiement hérite de la devise de sa facture. Aucun envoi ACH identifié. |
| Comptabilité et clôture | Comptes configurables, journaux équilibrés, périodes et rapports (`accounting.rs:520`, `accounting.rs:967`). | Opérationnel CH ; saisie de journal CHF/EUR, rapports/clôture exigent base CHF et aucune devise étrangère non convertie. |
| TVA | Profils datés, classifications, ajustements, aperçu et XML `vat_reporting.rs:528`, `vat_reporting.rs:649`, `vat_reporting.rs:2998`. | Opérationnel dans le code CH ; eCH-0217, identité CHE et CHF. Sales tax US absent du modèle inspecté. |
| Équipe et paie | Cotisations, validation, comptabilisation et paiement natifs (`payroll.rs:528`, `payroll.rs:740`, `payroll.rs:852`). | Implémentation CH avec limites réglementaires explicites. Paie US, W-2/1099 et transmission fiscale US non identifiés. |
| Agenda | Dates et heures locales, rattachements projet/collaborateur, écritures natives (`agenda.rs:17`, `agenda.rs:142`). | Opérationnel local ; événements sans identifiant de fuseau IANA dans les contrats inspectés. |
| Rapports et PDF | Marges par projet `ProjectReports.tsx:7`, états financiers PDF `commands.rs:1271`, PDF salaires/certificat `commands.rs:1543`, `commands.rs:1562`. | Partiel pour US : base CHF, labels français, A4. `ReportsScreen` inspecté n’expose pas d’export PDF de projet autonome. |
| Langues de l’interface | Quatre langues, préférence appareil, dictionnaires et paramètres (`language.ts:4`, `language.ts:27`, `language.ts:37`). | Mécanisme opérationnel, couverture partielle ; anglais utilise `en-CH`, pas `en-US`. |

Les chemins abrégés du tableau appartiennent à `desktop/src/` pour TypeScript/TSX et à `desktop/src-tauri/src/` pour Rust/SQLite. L’inventaire de navigation est visible dans `desktop/src/WorkspaceApp.tsx:405` ; les ensembles persistés sont exposés par `desktop/src/types.ts:1746`. Aucun écran Notes autonome n’est présent dans ces deux contrats du checkout audité ; les champs `notes` des entités existent. Le module Notes d’un autre checkout ne doit pas être réputé intégré sur cette seule base.

## Couplages CH et points d’extension

### 1. Séparer langue, région d’affichage et juridiction de l’entreprise

`desktop/src/language.ts:4` définit `fr/de/it/en` ; `language.ts:9` les associe exclusivement à `fr-CH/de-CH/it-CH/en-CH`. La préférence `zentra.interface.language.v1` est stockée sur l’appareil. `setAppLanguage` change la présentation et la langue du document HTML, sans modifier l’entreprise (`language.ts:27`). `t` laisse les valeurs utilisateur littérales et conserve les chaînes inconnues dans leur langue source (`language.ts:37`).

Le sélecteur avertit déjà que certains écrans et PDF restent français (`desktop/src/LanguageSetting.tsx:14`). `docs/LANGUES-INTERFACE.md:21` délimite les formulaires, messages natifs, assistant et contrôles natifs non entièrement traduits. Les composants financiers montrent encore des textes fixes, par exemple `desktop/src/AccountingScreen.tsx:491` et `desktop/src/ProjectReports.tsx:15` ; traduire les composants communs ne couvre pas automatiquement tout JSX.

**Extension identifiée :** conserver l’interface choisie comme préférence d’affichage, ajouter une région de formatage indépendante et une configuration métier typée par entreprise. Le pays d’adresse ne doit pas modifier implicitement ses calculs fiscaux, ses documents déjà émis ou sa paie. La locale d’interface ne doit pas devenir un commutateur fiscal.

### 2. L’onboarding est multilingue, mais structurellement suisse

`desktop/src/onboardingDraft.ts:20` initialise `country: CH`, puis CHF (`:24`). `desktop/src/onboardingValidation.ts:191` exige le canton ; `:197` vérifie la section/division NOGA. Le mode essentiel peut différer la facturation (`:215`), mais conserve l’identité et l’activité NOGA. La configuration complète exige un IBAN CH/LI de 21 caractères (`:220`). Le formulaire reprend ces champs dans `desktop/src/Onboarding.tsx:515` et `:546`.

Le natif valide aussi l’activité (`desktop/src-tauri/src/database.rs:1198`, `:3343`) et l’IBAN effectivement fourni (`:1369`, `:3351`). `desktop/src-tauri/src/noga.rs:186` exige une section NOGA 2025 et `:214` contraint le code détaillé à sa division. Traduire les 109 codes NOGA n’ajoute pas une classification américaine.

`Organization` et `AppSettings` n’ont pas de champ EIN, profil fiscal US ou taxonomie d’activité distincte (`desktop/src/types.ts:24`, `:183`). `uidNumber` et `vatNumber` sont des textes ; le contrôle général exige surtout une valeur non vide (`desktop/src-tauri/src/database.rs:6959`), alors que le décompte TVA exige une identité CHE (`desktop/src-tauri/src/vat_reporting.rs:2916`). Il faut conserver cette distinction et ne pas traiter un EIN comme un CHE.

**Extension identifiée :** règles et vocabulaire du formulaire par profil métier, avec adresses ISO, subdivision canton/État et identifiants fiscaux typés. L’absence d’IBAN doit pouvoir avoir un sens explicite pour US, sans affaiblir la validation CH. NOGA, NAICS et description libre sont des contrats différents, pas des traductions de labels.

### 3. Une devise textuelle existe sur les ventes ; USD de bout en bout reste absent

`desktop/src/types.ts:39` définit `BillingSettings.currency` comme `'CHF'`. `desktop/src/bridge.ts:1302` reconstitue toujours CHF depuis les réglages, même si la ligne SQLite contient une autre devise. Le natif accepte en revanche un code de trois lettres sur plusieurs chemins (`desktop/src-tauri/src/database.rs:1177`, `:5885`). Cette asymétrie suffit à rendre un réglage USD instable lors d’un aller-retour frontend.

Les devis/factures et leurs snapshots ont une devise explicite (`desktop/src/types.ts:453`, `:503`, `desktop/src-tauri/src/schema.rs:390`, `:434`). Le PDF final refuse de la remplacer silencieusement par CHF (`desktop/src-tauri/src/sales_pdf.rs:620`). Le catalogue est déjà désactivé sur un document non-CHF pour éviter une conversion inventée (`desktop/src/DocumentEditor.tsx:294`, `:730`).

Les chemins suivants restent bloqués ou écrivent CHF :

- Commande client depuis devis et commande libre : `desktop/src-tauri/src/sales_fulfillment.rs:737`, `:835` ; facture depuis livraison `:3291`.
- Récurrence : `desktop/src-tauri/src/recurrence.rs:315`.
- Facture de temps : `desktop/src-tauri/src/time_billing.rs:410`.
- Fournisseur et dépense : `desktop/src-tauri/src/database.rs:6500`, `:6554` ; fournisseur et facture fournisseur SQLite `schema.rs:349`, `:732`.
- Commande fournisseur : `desktop/src-tauri/src/supplier_procurement.rs:732` ; avoirs et imputations `:1779`, `:1813`, `:1915`.

Les coûts de catalogue, salaires et budgets de projet n’ont pas de devise individuelle. Les marges refusent une agrégation non-CHF sans conversion (`desktop/src/utils.ts:177`, `:203`), ce qui constitue une protection utile à conserver.

**Extension identifiée :** un contrat de devise d’entreprise transmis et relu sans coercition, puis propagé à chaque chemin de création. Pour une première entreprise US exclusivement USD, distinguer prise en charge USD et véritable multi-devise : le second exige un registre de change, des contre-valeurs, une date et une preuve de taux. Retirer les refus sans ces données produirait des totaux faux.

### 4. Émission, paiements et QR : découpler la politique suisse

Toute facture ordinaire non-avoir exige aujourd’hui un IBAN suisse/liechtensteinois avant émission (`desktop/src-tauri/src/database.rs:3505`). Cette règle s’applique même si sa devise est un autre code ISO. Une entreprise US sans compte CH/LI ne dispose donc pas d’un parcours normal d’émission autonome.

Le moteur QR est une implémentation distincte : IBAN CH/LI, CHF/EUR, références QRR/SCOR/NON, montants et limites SPC (`desktop/src-tauri/src/swiss_qr.rs:470`). Le profil QRR propre à Zentra est CHF seulement (`:502`). L’ajout automatique depuis snapshot saute les comptes/devises hors périmètre (`:151`), mais cela ne supprime pas la validation d’IBAN de l’émission.

`payments` n’a pas de devise ou de taux de change propre (`desktop/src-tauri/src/schema.rs:832`) : le montant est rattaché à sa facture. Le système confirme une réception enregistrée ; il ne constitue pas un rail de paiement US. Aucun contrat ABA/routing/account number, envoi ACH ou rapprochement de change n’a été identifié dans les commandes inspectées.

**Extension identifiée :** politique d’émission et instructions de paiement par profil. Garder Swiss QR dans son domaine validé ; un document US peut avoir un mode de paiement différent sans fausse section QR. Conserver les comparaisons montant/devise et les protections anti-doublon des paiements et remboursements.

### 5. Taxes : le calcul de ligne n’est pas un moteur fiscal US

Les lignes stockent un seul `vat_bp` entier, base nette, TVA et total (`desktop/src-tauri/src/schema.rs:402`, `:447`). Le frontend applique un arrondi par ligne après quantité et remise (`desktop/src/utils.ts:67`, `:74`). Les taux sont compris entre 0 et 10 000 points de base. Cette représentation ne porte ni autorité fiscale, ni juridiction, ni catégorie taxable, ni certificat d’exonération, ni composition de taxes. Un taux demandant plus de deux décimales de pourcentage ne peut pas être conservé exactement en points de base entiers.

La TVA native est nettement plus riche que le seul calcul : profils datés, méthodes effective/TDFN, convenu/encaissé, classifications vente/impôt préalable, ajustements, concordance, dates closes et export. Références : `desktop/src-tauri/src/vat_reporting.rs:528`, `:649`, `:811`, `:817`, `:856`, `:2998`. Le standard est eCH-0217 (`:36`), l’identité est CHE (`:2916`) et le décompte est CHF (`:1761`, `:2106`). Les sources en devise étrangère sont signalées et ne sont pas silencieusement additionnées (`:2192`).

**Absent :** modèle de sales tax US, règles de localisation/nexus, combinaison État/autorités locales, traçabilité des exonérations et déclarations US dans les surfaces inspectées. Aucun taux ou obligation US n’est validé par cet audit. Ajouter USD et remplacer le mot TVA par tax ne fournit pas ces capacités.

**Extension identifiée :** calcul/taxes documentaires et reporting fiscal comme contrats séparés, versionnés et datés. Définir les composants de taxe, bases, précision, règles d’arrondi et motifs d’exonération avant leur persistance. Préserver les anciens `vat_bp` et snapshots CH ; ne pas les recalculer avec un moteur nouveau.

### 6. Comptabilité : générique par certains mécanismes, CHF par ses limites

Les comptes et liaisons sont configurables ; le démarrage crée toutefois un plan avec numéros et libellés suisses (`desktop/src-tauri/src/accounting.rs:345`). Les écritures utilisent des cents, une devise et des comptes de type/solde validés. `accounting.rs:3447` limite la devise de journal à CHF/EUR.

Les états et la clôture appellent `ensure_base_currency_for_ranges` (`desktop/src-tauri/src/accounting.rs:967`, `:1014`, `:1071`). Cette fonction exige une monnaie de tenue CHF et refuse les lignes étrangères sans registre de conversion (`desktop/src-tauri/src/accounting_closure.rs:110`). Son résultat annonce `exchange_rates_applied: false` (`:159`). Plusieurs présentations de rapport appellent `formatMoney` sans passer leur devise (`desktop/src/AccountingScreen.tsx:461`, `:463`, `:523`). Les saisies manuelles affichent « Débit CHF / Crédit CHF » (`:491`).

**Extension identifiée :** devise de tenue validée par entreprise, plan et rubriques de reporting sélectionnés par profil, API de rapports qui ne perd pas sa devise jusqu’au rendu. Ne pas supprimer les refus de mélange ; rendre d’abord possible un jeu d’écritures exclusivement USD, puis traiter séparément les opérations de change.

### 7. Banque : adapter les formats d’entrée sans inventer un service bancaire

Le parser reconnaît les namespaces CAMT 053/054 versions .001.04/.001.08 (`desktop/src-tauri/src/bank_import.rs:269`) ; le schéma les contraint aussi (`desktop/src-tauri/src/schema.rs:849`). Les devises CAMT sont des codes de trois lettres (`bank_import.rs:201`) et les comptes peuvent être associés explicitement, ce qui est réutilisable. Les montants sont limités à deux décimales (`:243`). Références de paiement, chronologie, statut BOOK/PDNG et écarts de devise conditionnent les suggestions et confirmations.

Le frontend décrit bien un import de relevé XML, pas une connexion bancaire en direct (`desktop/src/BankScreen.tsx:611`). Le formatage local du module reste `fr-CH` (`:80`). Aucun parseur OFX/QFX ou import bancaire CSV US n’a été trouvé dans le module bancaire inspecté ; les occurrences `ACH-2026-*` des fixtures sont des références d’achat, pas une implémentation ACH.

**Extension identifiée :** adaptateurs d’import vers le mouvement normalisé existant, avec empreinte, compte/devise, idempotence, source et validation humaine. Réutiliser ensuite les protections de rapprochement. Une autre source ne doit pas pouvoir contourner les contrôles existants de devise, solde, doublon ou compte associé.

### 8. Documents : préserver le moteur, ajouter des politiques explicites

Les exports commerciaux utilisent un vrai moteur PDF natif, des données figées et la comparaison des preuves d’émission. Les champs indispensables sont vérifiés (`desktop/src-tauri/src/sales_pdf.rs:426`) ; les montants figés sont contrôlés au lieu d’être recalculés depuis des lignes incomplètes (`:845`). Le renderer dispose de composition, styles et fontes, avec tests des fontes embarquées (`desktop/src-tauri/src/document_embedded_font_tests.rs:26`, `:55`).

Les dimensions commerciales sont A4 (`desktop/src-tauri/src/sales_pdf.rs:28`). Les PDF financiers et salariaux sont aussi A4 (`desktop/src-tauri/src/financial_pdf.rs:419`, `desktop/src-tauri/src/payroll_pdf.rs:24`). Libellés TVA, titres et métadonnées sont français (`sales_pdf.rs:1060`, `:1210`, `:1260`). Les dates sont `jour.mois.année` et les montants utilisent apostrophe de milliers et deux décimales (`sales_pdf.rs:3277`, `:3319`). Aucun choix Letter/locale/langue documentaire par entreprise n’a été identifié dans les modèles inspectés.

**Extension identifiée :** langue de document, région de formatage, format de page et mentions commerciales par profil, enregistrés dans le contrat de génération/snapshot. Conserver le renderer existant et les contrôles des éléments figés. La langue d’interface ne doit ni traduire les notes/client/prestations, ni altérer après émission le contenu commercial historique. La conformité documentaire US reste à définir pour le périmètre choisi ; cet audit ne la certifie pas.

### 9. Paie : isoler clairement le domaine CH

Le moteur appelle explicitement les règles suisses (`desktop/src-tauri/src/payroll.rs:18`). Le profil fédéral est daté et les catégories d’assurance distinctes (`:357`). Les règles LAA/LPP 2026 et leur périmètre temporel sont codés (`desktop/src-tauri/src/swiss_payroll_rules.rs:10`, `:74`). L’impôt à la source reconnaît les 26 cantons (`desktop/src-tauri/src/source_tax.rs:36`). Le certificat annuel exige un numéro AVS suisse et exporte le formulaire 11 (`desktop/src-tauri/src/salary_certificate.rs:450`, `:403`).

Le produit indique déjà que l’export local du certificat n’est pas une transmission ELM et qu’il n’est pas certifié Swissdec (`desktop/src/SwissPayrollRulesPanel.tsx:105`). La présence de PDF et de tests n’est donc pas une preuve de certification CH. Aucun moteur de paie US ou déclaration W-2/1099 n’est identifié ici.

**Extension identifiée :** capacité paie CH explicite, isolée de la gestion commune. Un pilote US peut différer la paie réglementaire, mais doit le rendre visible et bloquer les calculs suisses appliqués à une entreprise US. Ne pas renommer AVS/LPP en cotisations US ni réutiliser les plafonds CH sous de nouveaux labels.

### 10. Agenda, unités et saisie : limites moins visibles, mais réelles

`desktop/src-tauri/src/agenda.rs:27` emploie `NaiveDate` et `NaiveTime` ; l’écriture stocke dates et heures sans fuseau (`:142`). `desktop/src/agenda.ts:59` manipule des dates locales. La locale de `formatDateTime` change les textes mais utilise le fuseau de l’environnement (`desktop/src/utils.ts:34`). Aucun contrat de fuseau d’entreprise/événement n’est identifié dans `AppSettings` ou l’événement inspecté.

Le catalogue stocke une unité textuelle libre, ce qui permet d’autres unités, mais ses suggestions sont heure/pièce/mètre/litre/kg/m² (`desktop/src/CatalogItemForm.tsx:89`). Les prix de catalogue sont explicitement CHF (`:88`, `:100`). Les conversions d’unités ne sont pas un comportement identifié.

Les fonctions génériques d’entrée numérique enlèvent les espaces et changent la virgule en point (`desktop/src/utils.ts:55`, `:61`). Elles ne sont pas des parseurs complets de nombres formatés selon toutes les régions. Ne pas supposer qu’une entrée avec séparateurs de milliers US ou suisses devient fiable parce que `Intl.NumberFormat` affiche ces formats.

**Extension identifiée :** conserver les dates comptables comme dates civiles, ajouter un fuseau explicite là où un rendez-vous représente une heure réelle, et tester DST/changement de région. Définir les formats de saisie acceptés et distinguer stockage canonique, champ numérique et texte formaté. Les unités libres doivent rester littérales et les conversions éventuelles explicites.

### 11. Import de message fournisseur : une porte d’entrée locale, actuellement CHF

`desktop/src-tauri/src/supplier_email.rs:84` inspecte un fichier `.eml`/`.txt` ; `:131` extrait les pièces importables. L’import demande un justificatif original sélectionné et conserve sa provenance (`:310`, `:394`). Une devise étrangère détectée bloque le chemin comptable automatique (`:225`). Le détecteur reconnaît aussi EUR/USD/GBP (`:1146`), ce qui ne prouve pas leur prise en charge dans la facture fournisseur.

`docs/US-PILOT.md:7` constate le même périmètre local et `aiUsed: false`. Le pilote web mentionné dans ce document ne fournit pas un moteur fiscal ou une connexion mail dans le desktop (`:9`). L’audit n’attribue donc pas aux simulations de la landing ou de la démo des capacités natives réelles.

**Extension identifiée :** adapter le schéma de brouillon au profil de l’entreprise et conserver validation humaine, pièce source et empreintes. Ne pas déclarer un import USD opérationnel avant de modifier les contraintes des achats, les taxes et la comptabilisation en aval.

### 12. Schéma, sauvegardes et synchronisation sont une frontière de migration

SQLite utilise des transactions immédiates, des contraintes et des triggers d’immutabilité. L’émission fige `helvichantier.document_snapshot.v1` (`desktop/src-tauri/src/database.rs:7570`, `:7618`) ; les documents émis conservent leurs données financières (`desktop/src-tauri/src/schema.rs:7003`). Ajouter un profil de marché ne doit pas réécrire rétroactivement ces preuves.

`LocalStore::migrate` refuse une version locale plus récente que l’application (`desktop/src-tauri/src/database.rs:1526`). Le contrat sync liste ses colonnes et rejette les tables/champs non reconnus (`desktop/src-tauri/src/business_sync.rs:241`, `:257`). Les contrats historiques 60/61 conservent leurs octets, ordre de colonnes et empreintes propres (`desktop/src-tauri/src/business_sync/contracts.rs:1`, `:41`). Le contrat courant est 62, alors que la base locale est 67 : ne pas confondre ces numérotations.

**Extension identifiée :** migration additive sur copies de bases synthétiques et historiques, évolution explicite des contrats natifs/frontend/sync/backup, compatibilité des anciens snapshots et tests de projection. Mettre un champ improvisé dans un JSON ou élargir une table seule n’est pas une intégration complète : le bridge, les listes de champs autorisés, les exports et les contrats de réplication doivent faire le même aller-retour.

## Preuves de tests présentes, non exécutées dans cet audit

| Domaine | Exemple de preuve source | Ce que cette preuve ne démontre pas |
| --- | --- | --- |
| Langue et conservation des données | `desktop/src/language.test.ts:15`, `:27`, `:32`, `:52` ; `desktop/src/payslipLanguage.test.ts:50`. | Traduction intégrale, locale US ou calcul fiscal américain. |
| Onboarding et IBAN | `desktop/src-tauri/src/lib.rs:1576`, `:1616`, `:2475`. | Entreprise US valide sans compte CH/LI. |
| Documents et snapshots | `desktop/src-tauri/src/sales_pdf.rs:3554`, `:3584`, `:3670`, `:3776`, `:3847`, `:3998`. | Mentions US valides, format Letter ou chaîne USD complète. |
| Swiss QR | `desktop/src-tauri/src/swiss_qr.rs:838`, `:846`. | Nouveau schéma de paiement ou certification du produit par un portail externe. |
| Monnaies, banque | `desktop/src-tauri/src/accounting_closure.rs:511` ; `desktop/src-tauri/src/bank_import.rs:3045`, `:2719`. | Conversion de change ou intégration bancaire US ; les tests vérifient notamment des refus sûrs. |
| TVA et historique | `desktop/src-tauri/src/vat_reporting.rs:3734`, `:4145`, `:4470`, `:4483`, `:4610`. | Déclaration effectivement déposée ou sales tax US. |
| Contrat eCH | `desktop/tests/validate-vat-xml.py:1`, `:18`, `:42`. | Validation réalisée aujourd’hui ou acceptation d’un dépôt réel par l’administration. |
| Reprises/migrations | `desktop/src-tauri/src/database.rs:8675`, `:9650`, `:10522`, `:11540` ; `desktop/src-tauri/src/business_sync/schema_upgrade_tests.rs:48`. | Compatibilité d’une migration internationale qui n’existe pas encore. |
| IPC et écritures distinctes des lectures | `desktop/src/agendaBridge.test.ts:58`, `desktop/src/timeTrackingBridge.test.ts:7`, `desktop/src/recurrenceBridge.test.ts:15`. | Recette sur une installation client réelle. |

Les commandes déclarées sont `test:ui = vitest run`, `build:web = tsc --noEmit && vite build` (`desktop/package.json:9`) ; les tests Rust sont dans la crate Tauri. Les parcours `desktop/tests/*-journey.mjs` sont des harnais séparés, pas automatiquement la même preuve qu’un test IPC natif. Les résultats historiques décrits dans des documents ne sont pas repris comme verdict du checkout sale courant.

### Fichiers de tests prioritaires pour l’évolution CH / US

Ces priorités proposent une extension des tests existants ; elles ne décrivent pas des tests US déjà présents ni des résultats exécutés.

| Priorité | Fichiers existants à étendre | Risque à verrouiller |
| --- | --- | --- |
| P0 — profil et cycle financier | `desktop/src/onboardingDraft.test.ts`, tests natifs de `desktop/src-tauri/src/lib.rs`, `sales_fulfillment.rs`, `supplier_procurement.rs`, `time_billing.rs`, `recurrence.rs` ; `desktop/src/recurrenceBridge.test.ts`. | Profil US conservé à la relecture ; devise propagée sur chaque création et conversion ; scénario CH inchangé ; pas de validation CH appliquée silencieusement à US. |
| P0 — monnaie, taxes et clôture | Tests natifs de `desktop/src-tauri/src/accounting.rs`, `accounting_closure.rs`, `vat_reporting.rs`, `supplier_draft_vat_tests.rs`, `input_vat_tests.rs`, `vat_received_credit_tests.rs`, `customer_credit_recovery_vat_tests.rs` ; `desktop/src/accountingManualJournal.test.ts`, `vatPreviewBridge.test.ts`. | Arrondis et contre-écritures exacts ; journal/rapports USD cohérents ; refus de mélange sans taux ; TVA CH et déclarations historiques préservées. |
| P0 — migration et histoire | Tests de `desktop/src-tauri/src/database.rs`, `business_sync/contracts.rs`, `business_sync/schema_upgrade_tests.rs`, `business_sync/snapshot/incoming/historical_tests.rs`, `business_sync/replay/delivery/historical_tests.rs`. | Schéma local et contrat wire évoluent explicitement ; sauvegarde/restauration et anciennes données restent lisibles ; snapshots émis ne changent pas. |
| P1 — documents, banque et affichage | Tests de `desktop/src-tauri/src/sales_pdf.rs`, `document_embedded_font_tests.rs`, `swiss_qr.rs`, `bank_import.rs` ; `desktop/src/language.test.ts`, `languageCatalogCoverage.test.ts`, `payslipLanguage.test.ts`, `catalogForm.test.ts`, `agendaBridge.test.ts` ; `desktop/tests/validate-vat-xml.py`. | PDF décodable et rendu par profil ; devise et contenu utilisateur conservés ; QR CH limité à son domaine ; imports idempotents ; séparation langue/locale/fuseau et unités littérales. |

Les noms Rust abrégés de cette table appartiennent à `desktop/src-tauri/src/`, les noms TypeScript abrégés à `desktop/src/`. Les suites paie CH existantes doivent continuer à fonctionner ; une activation de paie US nécessiterait un jeu de règles et des attentes indépendants, absents ici.

## Vérifications nécessaires avant une implémentation puis une disponibilité US

1. Figer les capacités du premier profil US : gestion USD seule, taxes manuelles ou moteur fiscal défini, moyen de paiement, paie différée ou réellement implémentée. Rendre les capacités différées explicites plutôt que conserver silencieusement les règles CH.
2. Vérifier les allers-retours du profil d’entreprise, de la devise, de la locale et des identifiants : onboarding, réglages, relecture IPC, sauvegarde/restauration, synchronisation et mise à niveau. Conserver les anciennes entreprises CH sans changement de comportement.
3. Parcourir nativement deux scénarios distincts CH/CHF et US/USD : client → devis → commande/livraison → facture → paiement, puis achat/avoir/remboursement, temps et récurrence. Vérifier chaque écriture et ses soldes ; une carte UI correcte ne suffit pas.
4. Définir et tester précision, arrondis signés, remises, taxes multiples, exonérations et corrections avec des attentes indépendantes du calculateur. La définition réglementaire US doit être vérifiée pour le périmètre commercial retenu avant toute promesse de conformité.
5. Vérifier rapports, clôture et comparaison annuelle par devise de tenue, ainsi que les refus de mélange sans taux traçable. Refaire les tests d’historique et d’immutabilité ; conserver les documents émis CH.
6. Décoder et rendre les PDF natifs de chaque profil : langue des libellés, contenu utilisateur littéral, nombres, dates, A4/Letter, longues adresses et montants, plusieurs pages, paiements et absence de QR US trompeur. Tester qu’un changement d’interface ne réécrit pas les documents figés.
7. Tester les formats d’entrée bancaire effectivement choisis, leurs erreurs, doublons, association de comptes et confirmations. Un envoi de paiement, s’il est ajouté ultérieurement, doit avoir un contrat propre ; l’import d’un relevé n’en constitue pas la preuve.
8. Tester événements dans plusieurs fuseaux, changements d’heure et dates civiles inchangées, puis quatre langues et locales d’affichage séparées. Compléter la couverture des écrans et messages natifs avant de promettre un produit intégralement anglais.

## Limites du relevé

Lecture ciblée des contrats, commandes, modèles, schémas/migrations, calculateurs, exports, écrans critiques et tests mentionnés. Les recherches ont exclu `node_modules`, `target`, `dist` et les fichiers de secrets ; aucun scan des données client n’a été fait. Les critères US absents ont été recherchés dans les sources desktop, notamment `market`, `jurisdiction`, `sales_tax`, `tax_jurisdiction`, `nexus`, `EIN`, `NAICS`, `USD`, `ACH`, `OFX` et `en-US` ; les quelques occurrences sont distinguées de fonctions métier.

Non vérifiés : binaires réellement installés, fonctionnement Windows/macOS/iOS/Android actuel, comptes ou serveurs réels, performance/concurrence, conformité légale courante, dépôts fiscaux, licences US, état d’intégration des autres checkouts, publication du pilote et fonctionnement des modules Support/Automation web. Ces aspects relèvent d’audits distincts ou d’une recette explicitement préparée. Aucune conclusion de cet audit ne vaut autorisation de migration, déploiement ou activation de production.
