# Matrice de conformité suisse — Zentra

Cette matrice sert de base de recette pour la source Zentra 1.19.0. Elle ne remplace ni une certification Swissdec, ni la validation d’une fiduciaire, ni le contrôle du PDF QR par le portail SIX.

## Profil d’activité multisectoriel

Le premier lancement demande une section et une division de la NOGA 2025 ainsi qu’une description précise de l’activité. Le catalogue embarqué couvre les 22 sections A à V et leurs 87 divisions. Le choix est validé puis conservé dans la base locale et dans les sauvegardes ; il adapte le vocabulaire du module « Chantiers / projets » sans retirer ce module.

La checklist de prise en main 1.18 est un indicateur d'usage, pas une preuve de conformité. Elle n'emploie ni données de démonstration ni cases de validation manuelle : son avancement est recalculé à partir d'un client actif, d'un projet lié à ce client, d'un devis numéroté et accepté, d'une facture numérotée et émise depuis ce devis, d'un paiement positif rattaché à une écriture active cohérente, puis d'une sauvegarde réellement créée avec son chemin et sa date. Supprimer ou invalider une preuve rend l'étape de nouveau incomplète.

Source : [OFS / KUBB — NOGA 2025](https://www.kubb-tool.bfs.admin.ch/fr/noga/2025).

## Factures et TVA

Une facture doit exposer au minimum l’identité et l’adresse du fournisseur et du client, le numéro TVA du fournisseur lorsqu’il est assujetti, la date ou période de la prestation, la nature/quantité de la prestation, la contre-prestation ainsi que la TVA et son taux.

Contrôles logiciels attendus :

- identité complète de l’émetteur et du client ;
- numéro unique, date d’émission, date/période de prestation et échéance ;
- lignes avec nature, quantité, unité, prix et taux TVA explicite ;
- ventilation des bases et montants par taux ;
- document émis immuable ; correction par avoir, jamais par suppression ;
- journal d’audit et numérotation transactionnelle sans doublon.

Source : [AFC — facturation et transfert de la TVA](https://www.estv.admin.ch/dam/fr/sd-web/598rboPYYga5/mwst-publ-amwstg-545-10-fr.pdf).

## QR-facture suisse

Référence actuellement applicable : Swiss Implementation Guidelines QR-bill version 2.3. Depuis le 22 novembre 2025, seules les adresses structurées sont admises dans le Swiss QR Code.

Contrôles logiciels attendus :

- payload `SPC`, version `0200`, codage `1` ;
- IBAN/QR-IBAN valide ;
- QR-IBAN uniquement avec référence `QRR` de 27 chiffres et contrôle modulo 10 récursif ;
- IBAN standard avec `SCOR` valide ou sans référence (`NON`) ;
- monnaie CHF ou EUR et montant dans les limites de la norme ;
- adresses structurées avec code pays ISO 3166-1 à deux lettres ;
- QR niveau de correction M, maximum 997 caractères, taille imprimée 46 × 46 mm ;
- bande paiement + récépissé de 210 × 105 mm au bas de l’A4 : récépissé 62 × 105 mm à gauche et section paiement 148 × 105 mm à droite ;
- validation du payload et du PDF final avant publication commerciale.

Sources : [SIX — QR-bill](https://www.six-group.com/en/products-services/banking-services/payment-standardization/standards/qr-bill.html), [Implementation Guidelines QR-bill 2.3](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf), [Style Guide QR-bill 1.1](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/style-guide-qr-bill-en.pdf).

## Salaires 2026

Les règles ci-dessous reflètent les sources officielles disponibles au
2 septembre 2026. Tous les paramètres doivent rester versionnés par date de
validité ; les taux de caisse, d’assureur et les barèmes cantonaux ne peuvent pas
être remplacés par une valeur nationale supposée.

### AVS, AI, APG et AC

- Pour chaque partie, salarié et employeur, les taux 2026 sont AVS 4,35 %,
  AI 0,7 %, APG 0,25 % et AC 1,1 %. L’AC est prélevée jusqu’au gain annuel
  maximal assuré de CHF 148'200.
- L’obligation AVS/AI/APG commence le 1er janvier de l’année qui suit celle du
  17e anniversaire. Après l’âge de référence, l’AVS/AI/APG restent dues, mais
  pas l’AC. La date de l’âge de référence doit être une donnée explicite : le
  relèvement transitoire prévoit 64 ans et 3 mois pour les femmes nées en 1961,
  64 ans et 6 mois pour 1962, 64 ans et 9 mois pour 1963, puis 65 ans dès
  l’année de naissance 1964.
- Après l’âge de référence, la franchise est de CHF 16'800 par année civile
  complète et par employeur. Pour une activité inférieure à un an, elle est de
  CHF 1'400 par mois civil entier ou entamé. Le salarié peut y renoncer
  séparément pour chaque employeur ; il doit l’annoncer au plus tard lors du
  premier salaire concerné. La décision vaut pour toute l’année civile et est
  reconduite si aucun changement n’est annoncé. L’année où l’âge de référence
  est atteint, seule la part correspondant au salaire versé dès le mois suivant
  peut bénéficier de la franchise.
- Dans le secteur ordinaire, si le salaire d’un emploi ne dépasse pas
  CHF 2'500 sur l’année civile, les cotisations AVS/AI/APG/AC ne sont en principe
  prélevées qu’à la demande de l’assuré. Le test porte sur le cumul réel par
  emploi, année et employeur, pas sur une extrapolation mensuelle. Dès que le
  seuil est dépassé, les cotisations sont dues sur la totalité du salaire annuel,
  et non uniquement sur la fraction supérieure à CHF 2'500.
- Dans un ménage privé, l'assujettissement est obligatoire quel que soit le
  revenu, sauf pour une personne couverte jusqu'au 31 décembre de l'année de ses
  25 ans lorsque le salaire ne dépasse pas CHF 750 par année et par employeur.
  Le dépassement de CHF 750 rend la totalité du salaire concerné cotisant. Les
  emplois dans les domaines artistiques et culturels visés sont toujours
  cotisants.
- Une demande de cotiser formulée sous le seuil s'applique prospectivement à
  partir de la décision documentée : elle ne rend pas rétroactivement cotisants
  les salaires déjà versés. Une cotisation déjà prélevée sur demande ne peut pas
  être retirée rétroactivement. Cette demande volontaire ne se confond pas avec
  le rattrapage obligatoire de l'ensemble du salaire lorsque le seuil est
  effectivement franchi.
- Le régime du salaire minime ne se cumule pas avec la franchise AVS accordée
  après l'âge de référence. Le moteur doit refuser cette combinaison au lieu de
  choisir silencieusement l'assiette la plus favorable.
- Le contrôle Zentra 1.18 conserve l'année, le secteur, la date de décision, la
  référence de preuve, le brut d'ouverture et la base d'ouverture déjà cotisée.
  Il dérive ensuite le cumul et le rattrapage depuis les fiches locales
  antérieures validées, comptabilisées ou payées et enregistre une trace locale
  du calcul. Les valeurs cumulatives libres reçues de l'interface ne font pas
  autorité.
- La déclaration de salaire AVS définitive doit parvenir à la caisse au plus tard
  le 30 janvier suivant la fin de l’année de cotisation.

Sources : [AVS/AI — tableau synoptique, état au 1er janvier 2026](https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf), [AVS/AI — mémento 2.01, état au 1er janvier 2026](https://www.ahv-iv.ch/p/2.01.f), [AVS/AI — mémento 2.04, cotisations sur les salaires minimes](https://www.ahv-iv.ch/Portals/0/Documents/Merkblaetter/Gruppe_2/2.04_f.pdf).

### LPP

- Les montants obligatoires valables dès le 1er janvier 2026 sont : seuil
  d’entrée CHF 22'680, déduction de coordination CHF 26'460, limite supérieure
  du salaire annuel CHF 90'720, salaire coordonné minimal CHF 3'780 et salaire
  coordonné maximal CHF 64'260.
- L’assurance obligatoire couvre d’abord les risques décès et invalidité dès le
  1er janvier suivant le 17e anniversaire ; l’épargne vieillesse commence le
  1er janvier suivant le 24e anniversaire. La durée du contrat, le salaire
  annualisé et les exceptions légales doivent aussi être contrôlés.
- Les bonifications de vieillesse légales de 7 %, 10 %, 15 % et 18 % selon
  les classes d’âge 25–34, 35–44, 45–54 et 55–65 portent sur le salaire
  coordonné : ce ne sont pas des retenues salariales universelles. Le règlement
  de l’institution fixe les cotisations effectives et leur répartition ; la
  contribution totale de l’employeur doit être au moins égale à celle de
  l’ensemble de ses salariés.

Source : [OFAS — montants AVS/AI/APG/PC/LPP valables dès le 1er janvier 2026](https://www.bsv.admin.ch/dam/fr/sd-web/sAgdISSXenMT/f_Betr%C3%A4ge%202026.pdf).

### LAA, allocations familiales, IJM et impôt à la source

- Sous réserve des exclusions légales, les salariés doivent être couverts pour
  les accidents et maladies professionnels. La couverture des accidents non
  professionnels s’applique à partir de huit heures de travail hebdomadaires
  chez le même employeur.
- Le gain assuré LAA est plafonné à CHF 148'200 par année, soit CHF 406 par
  jour. La prime AAP est à la
  charge de l’employeur ; la prime AANP est en principe à la charge du salarié,
  sous réserve d’une convention plus favorable. Le taux réel dépend du profil
  transmis par l’assureur, de la classe de risque et de l’année. Les assurances
  complémentaires LAA et IJM sont contractuelles : aucun taux fédéral universel
  ne doit être prérempli.
- Les minima fédéraux des allocations familiales sont CHF 215 par mois pour
  l’allocation pour enfant et CHF 268 pour l’allocation de formation. Le seuil
  d’activité est CHF 630 par mois ou CHF 7'560 par année. Les montants, les
  contributions CAF, les droits et l’ordre de priorité dépendent du canton et de
  la caisse ; une seule allocation est versée par enfant. La participation du
  salarié au financement dans le canton du Valais est de 0,13 % de la masse
  salariale en 2026 et doit rester un paramètre cantonal daté.
- Le contrôle local exige exactement une ligne AAP et, lorsque le seuil de huit
  heures est atteint, exactement une ligne AANP ; il rejette les doublons et
  l’AANP non applicable. Il vérifie le plafond LAA proratisé selon la période
  d’emploi 30/360, le côté payeur, l’assiette, la date réellement contrôlée et
  la preuve de police. Le seuil AANP
  exige un horaire régulier confirmé ou, pour un horaire irrégulier, une moyenne
  hebdomadaire représentative documentée ; une valeur absente laisse la décision
  bloquée. Pour la CAF, chaque ligne doit être un taux positif sans plafond libre,
  appliqué au salaire soumis AVS, avec le canton, la caisse, la période et la
  source du tarif. L’exception salarié du Valais est liée au tableau synoptique
  2026 qui publie réellement le taux de 0,13 %, et non au tableau distinct qui ne
  publie que les montants des prestations.
- Hors ménages privés et activités artistiques/culturelles obligatoirement
  cotisantes, l'exception LAA liée à une entreprise n'employant que des personnes
  dont le salaire annuel remplit les conditions du salaire minime reste
  désactivée par défaut. Zentra ne l'accepte qu'avec une confirmation et une
  preuve pour l'année concernée et après contrôle de tous les salariés ayant été
  concernés pendant cette année, y compris les personnes parties ou inactives.
  Un seul cas incompatible rétablit l'exigence ordinaire de couverture AAP. Ce
  contrôle ne constitue ni une décision de l'assureur ni une certification.
- Une configuration IJM ne peut pas être déclarée complète avec le seul nom de
  l’assureur et une prime. Tant que le régime LAMal/LCA, le numéro de police, le
  taux de couverture, le délai d’attente, la durée des prestations et la
  répartition employeur/salarié ne sont pas conservés sous forme structurée,
  Zentra maintient ce contrôle en état incomplet et demande une validation
  contractuelle externe.
- Il n’existe pas de taux national unique d’impôt à la source. Le calcul exige
  notamment le canton compétent, le code-barème, l’état civil, le nombre
  d’enfants, l’appartenance religieuse lorsque pertinente, le taux d’occupation,
  les autres activités ou revenus déterminants et la période de paie. Les barèmes
  cantonaux officiels 2026 et leur format doivent être importés et datés ; le
  montant retenu doit figurer sur la fiche.

Sources : [Suva — personnes assurées selon la LAA](https://www.suva.ch/fr-ch/assurance/assurance-accidents/assurance-accidents-laa/assurance-accidents-qui-est-assure), [Suva — gain assuré maximal](https://www.suva.ch/fr-ch/accident/prestations-de-la-suva/prestations-en-especes), [Suva — déclaration des salaires et profil d’assurance](https://www.suva.ch/fr-ch/assurance/salaires-et-primes/declaration-des-salaires), [AVS/AI — tableau synoptique 2026, y compris le taux CAF salarié du Valais](https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf), [OFAS — allocations familiales, prestations et conditions](https://www.bsv.admin.ch/fr/allocations-familiales-prestations-et-conditions), [OFAS — montants cantonaux 2026](https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/OrwD3z_mIEOztplxBzs7qQ/Document/Kantone_2026_f-1.pdf), [AFC — impôt à la source](https://www.estv.admin.ch/fr/impot-a-la-source), [AFC — publication des barèmes 2026](https://www.estv.admin.ch/fr/newnsb/oVGe4ukuBCkl).

### Fiche de salaire et certificat annuel — formulaire 11

Le décompte remis au salarié lors du paiement du salaire et le certificat de
salaire annuel sont deux documents différents. L’art. 323b CO exige un décompte
écrit lors du paiement, sans imposer un modèle graphique fédéral unique. Le
certificat de salaire/attestation de rentes (formulaire 11) suit en revanche le
guide AFC/CSI, valable dès le 1er janvier 2026.

Exigences d’implémentation pour le formulaire 11 :

- produire en principe un certificat par employé et par année civile, avec
  l’ensemble des prestations et avantages appréciables en argent ; l’établir
  immédiatement en cas de départ ou de décès ;
- conserver les données d’identité, le numéro AVS et la date de naissance, la
  période de salaire, les cases de transport/repas, les rubriques 1 à 15, les
  totaux bruts et nets, les cotisations, l’impôt à la source, les frais, les
  observations, le lieu, la date et la personne responsable ; le certificat est
  signé sauf s’il est établi de manière entièrement automatisée ;
- gérer les rectificatifs sans effacer l’original et signaler les certificats
  multiples conformément au guide ;
- remettre le certificat à l’employé et envoyer aussi un exemplaire directement
  à l’administration fiscale dans les cantons de Bâle-Ville, Berne, Fribourg,
  Jura, Neuchâtel, Soleure, Valais et Vaud. L’envoi direct est facultatif à
  Lucerne.

Sources : [Fedlex — Code des obligations](https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr), [AFC/CSI — guide du formulaire 11 valable dès le 1er janvier 2026](https://www.estv.admin.ch/dam/fr/sd-web/afP1GDFr8gE3/dbst-form-lohna-wegleitung-2026-fr.pdf), [AFC — certificat de salaire et attestation de rentes](https://www.estv.admin.ch/fr/certificat-de-salaire-et-attestation-de-rentes).

### Swissdec ELM 5 et ELM 6

ELM est une norme de transmission et un programme de certification de logiciel,
pas une certification automatique de la comptabilité salariale de l’entreprise.
Son utilisation n’est pas une obligation légale générale : les déclarations
restent obligatoires dans leur domaine, mais des portails ou procédures propres
aux destinataires peuvent exister. Si ELM est utilisé, les contraintes de version
ci-dessous s’appliquent :

- ELM 4.0 pouvait encore transmettre l’impôt à la source de l’année 2025
  jusqu’au 31 mars 2026 et les autres domaines jusqu’au 30 juin 2026. Les
  déclarations d’impôt à la source portant sur les salaires 2026 exigent
  ELM 5.0 ou une version ultérieure ;
- ELM 5.1 est nécessaire pour transmettre la renonciation volontaire à la
  franchise AVS ;
- ELM 5.3 est nécessaire pour le cas des travailleurs frontaliers de France et
  deviendra obligatoire pour ce cas d’usage en 2027 ;
- Swissdec a publié les directives ELM 6.0 le 6 mars 2026 ; elles sont valables
  depuis le 1er avril 2026 et consolident les versions mineures 5.1 à 5.5. Les
  premières déclarations productives basées sur les nouvelles versions majeures
  sont attendues dès janvier 2027.

Conséquence produit : Zentra ne génère ni fichier ni transmission ELM et n’est
pas un logiciel certifié Swissdec. Si une implémentation 2026 est lancée, le
noyau de paie doit rester indépendant du schéma. ELM 5.0 suffit aux
transmissions classiques, mais la cible produit minimale recommandée est
ELM 5.1 afin de couvrir la renonciation à la franchise AVS, ou ELM 5.3 pour les
frontaliers de France ; une voie ELM 6 peut être préparée en parallèle pour
2027. Aucune mention
« certifié Swissdec », aucun logo et aucune promesse de transmission ne doivent
être publiés avant la certification officielle de la version exacte du produit
et des domaines concernés, puis sa présence dans la liste Swissdec.

Sources : [Swissdec — ELM](https://www.swissdec.ch/fr/elm), [Swissdec — arrêt d’ELM 4.0 et exigences 5.1/5.3](https://www.swissdec.ch/fr/abschaltung-elm-4-0), [Swissdec — publication d’ELM 6.0 et calendrier](https://www.swissdec.ch/fr/blog/normes-11/publication-des-nouvelles-versions-majeures-des-normes-swissdec-133), [Swissdec — concepteurs ERP certifiés](https://www.swissdec.ch/fr/certified-erp/), [Swissdec — destinataires de données](https://www.swissdec.ch/data-receiver).

### Limites actuelles de Zentra pour la paie

- La fiche de salaire PDF est un décompte interne détaillé ; elle ne remplace
  ni le formulaire 11 annuel ni les déclarations aux caisses, assureurs et
  autorités.
- Le garde LPP livré couvre les conditions minimales obligatoires 2026 et exige
  le règlement réel, sa fenêtre de validité, le salarié concerné, les
  composantes risque/épargne et une attestation de la part patronale globale.
  Il ne calcule pas les taux propres à l'institution, ne couvre pas encore les
  autres millésimes et ne remplace ni son règlement ni son décompte collectif.
- Zentra ne génère pas encore le formulaire 11 et ne réalise aucun envoi direct
  aux administrations fiscales cantonales.
- Zentra n’intègre pas un moteur officiel complet de barèmes d’impôt à la source :
  le montant issu du barème cantonal doit être saisi et sa référence conservée.
- Zentra ne génère et ne transmet aucune déclaration ELM et n’est certifié sur
  aucun domaine Swissdec.

Contrôles logiciels attendus :

- salaire de base, heures, indemnités, allocations et avantages explicites ;
- base, taux, part employé et part employeur visibles pour chaque cotisation ;
- plafonds et périodes documentés ;
- aucune retenue implicite ;
- provenance et période de validité des taux de caisse, d’assureur, cantonaux ou
  contractuels ;
- alerte plutôt que calcul inventé lorsqu’un barème d’impôt à la source ou une
  police d’assurance manque ;
- fiche verrouillée après validation et correction par extourne ;
- export et contrôle fiduciaire ;
- aucune revendication de conformité, certification ou transmission automatique
  tant que le contrôle ou la certification externe correspondant n’existe pas.

## Comptabilité

Le régime complet des art. 957 et suivants CO s’applique aux personnes morales,
sous réserve des exceptions prévues pour certaines associations et fondations,
ainsi qu’aux entreprises individuelles et sociétés de personnes ayant réalisé
au moins CHF 500'000 de chiffre d’affaires lors du dernier exercice. En dessous
de CHF 500'000, ces entreprises individuelles et sociétés de personnes doivent
au minimum tenir une comptabilité des recettes, des dépenses et du patrimoine.
Les obligations spéciales de la forme juridique, de la fiscalité, de la TVA ou
d’une branche restent réservées.

Sous le régime complet, la comptabilité doit permettre de constater les
transactions et la situation économique. Le rapport de gestion comprend les
comptes annuels — bilan, compte de résultat et annexe — et doit être établi puis
soumis à l’organe compétent dans les six mois suivant la fin de l’exercice. Un
inventaire et les pièces justificatives sont nécessaires. Des allègements ou
documents supplémentaires peuvent s’appliquer selon la forme et la taille ; ils
ne doivent pas être déduits automatiquement du seul chiffre d’affaires.

### Conservation CO/Olico et TVA

- Les livres et pièces comptables ainsi que les rapports de gestion et de
  révision se conservent dix ans à partir de la fin de l’exercice. Un exemplaire
  imprimé et signé du rapport de gestion et du rapport de révision doit être
  conservé.
- Les supports électroniques sont admis si le lien avec les transactions est
  garanti et si la lecture et la vérification restent possibles pendant tout le
  délai. Un support non modifiable ne doit pas permettre une modification ou un
  effacement indétectable.
- Sur un support modifiable, l’intégrité doit être garantie par des procédés
  techniques ; le moment de l’enregistrement doit pouvoir être prouvé sans
  falsification et les protocoles, journaux de connexions et données utiles
  doivent aussi être conservés. Une sauvegarde cloud, à elle seule, n’est pas un
  support non modifiable.
- Pour la TVA, les documents commerciaux en relation avec des biens immobiliers
  se conservent vingt ans ; le délai peut se prolonger si la prescription absolue
  de la créance fiscale n’est pas encore acquise.

Contrôles logiciels attendus :

- partie double : total débit égal au total crédit pour chaque écriture ;
- journal chronologique, grand livre, balance des comptes ;
- bilan et compte de résultat selon un plan comptable paramétrable ;
- clôture de période et périodes verrouillées ;
- protection cumulative de toute date antérieure ou égale à la fin de la
  dernière clôture définitive, y compris les intervalles non clôturés séparément ;
- pièces et écritures validées non supprimables ; extourne traçable ;
- export complet pour la fiduciaire et conservation locale ;
- dossier de clôture comprenant l’inventaire, les états, l’annexe légale, les
  pièces et les validations applicables à l’entité ;
- politique de conservation paramétrée par catégorie, date de départ, durée,
  gel, preuve d’intégrité, test de restauration et migration lisible.

### Limites actuelles de Zentra pour la comptabilité

Zentra fournit une partie double, un journal et un grand livre, des états, des
écritures immuables corrigées par extourne, le verrouillage de période, une
chaîne d’audit, des pièces jointes, des sauvegardes et un dossier de clôture.
Dans la source 1.18, la date de fin maximale des clôtures définitives forme une
borne cumulative : toute insertion, modification ou suppression historique du
journal, de ses sources ou des profils TVA est refusée, même lorsqu'un intervalle
antérieur n'avait pas sa propre clôture. Seul le rejeu strictement identique
d'une opération déjà enregistrée reste permis pour l'idempotence ; un rejeu
divergent est refusé, tandis qu'une correction réelle doit être datée après la
borne et référencer l'original. Un refus ne doit modifier ni les séquences, ni
l'audit, ni les rapports, empreintes ou dossiers `FINAL` existants.
Ces fonctions assistent un processus orienté CO/Olico, mais ne prouvent pas à
elles seules sa conformité juridique.

La source 1.19.0 n’établit pas l’annexe légale. Le coffre serveur calcule une
date minimale de conservation mais ne fournit pas un support WORM ni un horodatage
externe infalsifiable, et ne valide pas les inventaires, amortissements,
régularisations, évaluations, décisions d’approbation ou exigences propres à
l’entité. Un « bilan totalement conforme » ne doit donc pas être revendiqué sans
constitution du dossier complet et validation du responsable ou de la
fiduciaire.

Sources : [Fedlex — Code des obligations, art. 957 ss](https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr), [Portail PME — comptabilité obligatoire](https://www.kmu.admin.ch/fr/comptabilite-obligatoire-lobligation-de-tenir-une-comptabilite), [Portail PME — conservation électronique](https://www.kmu.admin.ch/fr/conservation-electronique-des-livres-de-comptes), [Fedlex — Olico](https://www.fedlex.admin.ch/eli/cc/2002/216/fr), [AFC — questions et réponses TVA sur les délais de conservation](https://www.estv.admin.ch/fr/questions-et-reponses).

## Relances

Les relances sont calculées localement à partir de l’échéance et des paiements. Toute communication externe doit être explicitement configurée par le client. Une relance conserve le niveau, la date prévue, la date de création/envoi, le modèle utilisé et les montants au moment de l’action.
