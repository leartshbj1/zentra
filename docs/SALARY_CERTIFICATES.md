# Certificat annuel de salaire suisse

Le parcours Équipe & salaires → Certificats annuels prépare le formulaire officiel AFC/CSI 11 en trois étapes : identité, montants, aperçu PDF. L'export est local et conserve une trace de l'édition et du SHA-256 du PDF dans le journal d'audit. Il ne transmet rien à l'administration et ne constitue pas une certification Swissdec.

Les rubriques proviennent des instantanés comptabilisés. Les fiches non comptabilisées sont signalées, sans estimation. Par défaut, les salaires sont rattachés à l'année de leur période : un salaire connu et dont le paiement est certain peut appartenir à décembre même s'il est payé en janvier (FAQ AFC, questions générales 5 et 6). Les fiches dont le paiement et la période couvrent deux années sont visibles et leur rattachement doit être justifié. Un bonus déterminé plus tard peut être réaffecté ; l'utilisateur contrôle les autres certificats pour éviter une double déclaration.

Les retenues d'impôt à la source structurées sont cumulées séparément selon l'année du paiement des fiches. Les arriérés/remboursements et les prestations absentes de Zentra restent à compléter et à justifier.

- Ch. 8 : rémunérations 1 à 7.
- Ch. 9 : AVS/AI/APG/AC/AANP à charge du salarié.
- Ch. 10.1 : LPP ordinaire ; rachats retenus sur salaire à classer en 10.2.
- Ch. 11 : brut moins 9 et 10, indépendamment du versement bancaire.
- IJM, compléments LAA et cotisations cantonales ne diminuent pas le net fiscal ; frais hors brut en 13.

Les montants sont conservés en centimes. Le formulaire imprime des francs entiers, avec net fiscal arrondi au franc le plus proche et compensation des écarts dans une rémunération existante pour conserver les équations visibles. Une annexe reprend les montants exacts lorsque nécessaire. Les textes longs passent aussi en annexe. Le PDF conserve les champs canoniques et leurs apparences ; les tests les rouvrent et les comparent.

Sources : [guide AFC 2026](https://www.estv.admin.ch/dam/fr/sd-web/afP1GDFr8gE3/dbst-form-lohna-wegleitung-2026-fr.pdf), [FAQ AFC 2026](https://www.estv.admin.ch/dam/fr/sd-web/36S9l-hXKaLr/dbst-form-lohna-faq-2026-fr.pdf), [arrondis documentés par SwissSalary](https://learn.swisssalary.ch/FR/Updates/Update-5064-002/lohnausweisbetragerunden.htm). L'origine du formulaire est documentée dans `desktop/src-tauri/assets/SOURCES.md`.
