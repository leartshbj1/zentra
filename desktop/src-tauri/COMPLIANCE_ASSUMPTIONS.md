# Hypothèses de conformité du backend local

Ce document décrit les choix techniques implémentés. Il ne remplace pas la
validation d'une fiduciaire, d'un fiscaliste, d'une caisse de compensation ou
d'un établissement financier.

## Documents et comptabilité

- Les documents émis reçoivent un `snapshot_json` immuable contenant l'émetteur,
  le client, les dates/périodes, les conditions et les lignes/taux au moment de
  l'émission. Une fiche de salaire comptabilisée reçoit le même type de snapshot.
- Une facture exige `service_date_from`; `service_date_to` peut être identique.
- Un avoir référence une facture émise, utilise sa propre séquence et ses
  montants comptabilisés sont négatifs.
- Le plan comptable n'est jamais prérempli. Chaque compte exige un
  `report_section` explicite afin de produire les rubriques de bilan et de compte
  de résultat prévues par le Code des obligations.
- Toutes les écritures sont en partie double, immuables après comptabilisation et
  refusées dans une période clôturée. La clôture est volontairement irréversible
  dans cette version; une correction passe par un avoir ou une extourne.

Sources primaires : [Code des obligations, art. 957a, 959a et 959b](https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377/20230901/de/pdf-a/fedlex-data-admin-ch-eli-cc-27-317_321_377-20230901-de-pdf-a-9.pdf).

## Paie

- Aucun taux salarial n'est appliqué silencieusement. Une définition stocke le
  taux ou le montant fixe, la base, le côté salarié/employeur, la source et sa
  période d'effet. Les bases coordonnées/personnalisées sont obligatoirement
  fournies par l'utilisateur.
- Le profil informatif `CH-2026` n'est jamais installé automatiquement. Il expose
  séparément, par part, AVS 4,35 %, AI 0,7 %, APG 0,25 % et AC 1,1 %, avec plafond
  AC annuel de CHF 148'200. L'application exige alors la base annuelle déjà
  consommée pour ne pas transformer ce plafond annuel en plafond mensuel.
- LPP, AAP, AANP, IJM, allocations familiales, impôt à la source et autres lignes
  restent explicitement configurés par le client, car ils dépendent notamment
  de la caisse, de l'assureur, du canton, du contrat ou de la situation du salarié.
- Les taux librement saisis dans le questionnaire sont importés une seule fois
  comme définitions de catégorie `other`, sur base brute visible et modifiable.
  Les listes historiques du questionnaire sont ensuite vidées afin qu'une
  définition personnalisée ou supprimée dans le moteur ne soit jamais recréée
  par une sauvegarde ultérieure des réglages.

Sources primaires : [OFAS, aperçu des cotisations](https://www.bsv.admin.ch/fr/cotisations-apercu), [Centre d'information AVS/AI](https://www.ahv-iv.ch/fr/M%C3%A9mentos/Cotisations-AVS-AI-APG-AC), [OFAS, financement LPP](https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle), [SECO, assurance-accidents](https://www.seco.admin.ch/fr/annonce-des-rapports), [AFC, impôt à la source](https://www.estv.admin.ch/fr/impot-a-la-source).

## QR-facture suisse

- Le générateur suit l'Implementation Guideline SIX QR-facture 2.3 : en-tête
  `SPC`, version de payload `0200`, codage `1`, adresses structurées seulement,
  champs du créancier final vides et 31 à 34 lignes sans saut final.
- La combinaison est vérifiée localement : QR-IBAN et QRR, ou IBAN ordinaire et
  SCOR/NON. IBAN/SCOR utilisent modulo 97; QRR utilise le modulo 10 récursif.
- L'IBAN d'entreprise est normalisé puis validé comme IBAN CH/LI avec contrôle
  modulo 97 au questionnaire, dans les réglages et avant la numérotation d'une
  facture non-avoir.
- Le payload validé est persisté avec la facture. Il peut être remplacé tant que
  la facture est un brouillon, puis il est figé dans la base et dans le snapshot
  documentaire à l'émission. Une facture émise issue d'une ancienne version et
  dépourvue de QR peut recevoir une première valeur, ensuite figée et auditée.
- Le profil QRR d'HelviChantier est volontairement limité au CHF. Le backend
  produit le payload SPC 2.3 mais pas le QR
  graphique/PDF; l'UI doit encoder en mode binaire, correction `M`, taille
  imprimée 46 x 46 mm avec la croix suisse officielle.
- Les procédures alternatives sont refusées tant qu'une syntaxe officiellement
  enregistrée n'est pas prise en charge explicitement.

Sources primaires : [SIX QR-facture](https://www.six-group.com/fr/products-services/banking-services/payment-standardization/standards/qr-bill.html), [Implementation Guidelines 2.3](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-fr.pdf), [spécification QR-IID/QR-IBAN](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/qr-iid-iban-en.pdf).

## Données et réseau

- La base, les pièces jointes, sauvegardes et exports restent dans le profil local
  Windows (ou dans le chemin local absolu explicitement fourni par
  `HELVICHANTIER_DATA_DIR`).
- Le backend ne contient aucun client HTTP, aucune télémétrie, aucun envoi de
  relance et aucune donnée métier de démonstration. `sent_manually` est seulement
  une trace locale déclarative.

## Profil d’activité NOGA

- Le questionnaire exige une section et une division compatibles de la NOGA
  2025 ainsi qu’une description libre de l’activité réelle. Le code détaillé est
  facultatif; s’il est fourni, son niveau (3, 4 ou 6 chiffres) et son préfixe de
  division sont contrôlés localement.
- Le catalogue embarqué contient les 22 sections et 87 divisions officielles,
  mais ne choisit jamais une activité à la place du client. Après migration
  d’une ancienne base, les champs restent vides et `activity_profile_required`
  demande une complétion ciblée sans masquer ni effacer les données existantes.

Source primaire : [OFS, KUBB NOGA 2025](https://www.kubb-tool.bfs.admin.ch/fr/noga/2025).
