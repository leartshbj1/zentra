# Matrice de conformité suisse — HelviChantier

Cette matrice sert de base de recette. Elle ne remplace ni une certification Swissdec, ni la validation d’une fiduciaire, ni le contrôle du PDF QR par le portail SIX.

## Profil d’activité multisectoriel

Le premier lancement demande une section et une division de la NOGA 2025 ainsi qu’une description précise de l’activité. Le catalogue embarqué couvre les 22 sections A à V et leurs 87 divisions. Le choix est validé puis conservé dans la base locale et dans les sauvegardes ; il adapte le vocabulaire du module « Chantiers / projets » sans retirer ce module.

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

Les taux nationaux 2026 sont AVS 4,35 %, AI 0,7 %, APG 0,25 % et AC 1,1 % jusqu’à CHF 148'200, pour le salarié comme pour l’employeur. Les primes LPP, AAP/AANP, IJM, allocations familiales et l’impôt à la source dépendent notamment de la caisse, de l’assureur, du canton, de l’âge et de l’employé ; elles doivent donc être paramétrées explicitement.

Contrôles logiciels attendus :

- salaire de base, heures, indemnités, allocations et avantages explicites ;
- base, taux, part employé et part employeur visibles pour chaque cotisation ;
- plafonds et périodes documentés ;
- aucune retenue implicite ;
- fiche verrouillée après validation et correction par extourne ;
- export et contrôle fiduciaire ;
- aucune mention « Swissdec certifié » avant réussite de la procédure officielle ELM 6.0.

Sources : [AVS/AI — taux 2026](https://www.ahv-iv.ch/fr/Formulaires/Listes-diverses/Tableau-synoptique-des-taux-de-cotisations-et-des-primes-applicables), [Swissdec — ELM 6.0](https://www.swissdec.ch/fr/elm).

## Comptabilité

La comptabilité doit permettre de constater les transactions et la situation économique, produire les comptes annuels et conserver les pièces comptables pendant au moins dix ans lorsque le régime complet du Code des obligations s’applique.

Contrôles logiciels attendus :

- partie double : total débit égal au total crédit pour chaque écriture ;
- journal chronologique, grand livre, balance des comptes ;
- bilan et compte de résultat selon un plan comptable paramétrable ;
- clôture de période et périodes verrouillées ;
- pièces et écritures validées non supprimables ; extourne traçable ;
- export complet pour la fiduciaire et conservation locale.

Sources : [Portail PME — comptabilité obligatoire](https://www.kmu.admin.ch/fr/comptabilite-obligatoire-lobligation-de-tenir-une-comptabilite), [Portail PME — compte de résultat](https://www.kmu.admin.ch/fr/compte-de-resultat-calculer-la-performance-de-son-entreprise).

## Relances

Les relances sont calculées localement à partir de l’échéance et des paiements. Toute communication externe doit être explicitement configurée par le client. Une relance conserve le niveau, la date prévue, la date de création/envoi, le modèle utilisé et les montants au moment de l’action.
