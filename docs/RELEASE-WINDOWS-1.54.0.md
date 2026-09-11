# Première fiche de salaire guidée — 1.54.0

La création d’une première fiche présentait les réglages du collaborateur et des assurances dans de longs formulaires. Certaines erreurs conduisaient au mauvais réglage : couverture AANP manquante vers les heures pourtant correctes, prime AAP manquante vers la décision annuelle des petits salaires.

## Parcours livré

- Après le salaire du mois, les informations manquantes sont présentées une par une, avec le document à consulter et un bouton vers le bon formulaire. Le salaire saisi reste dans la fiche pendant les corrections.
- Identité, contrat et historique annuel sont découpés en questions courtes. Les valeurs invalides ouvrent la question et le champ concernés.
- Une correction du salaire annuel de pension ne modifie que les deux champs annuels. Le contrat de pension conserve les autres assurances et le canton.
- Les parts mensuelles de pension salarié/entreprise sont réunies, avec confirmation du certificat. Les contrats complexes restent dans le formulaire détaillé. Une panne entre les deux écritures peut être réessayée sans créer de doublon ; les deux écritures ne sont pas une transaction atomique.
- Les cotisations déjà enregistrées peuvent être ajoutées explicitement sans effacer les bases manuelles. Les taux AVS/chômage disposent d’un écran dédié ; les primes privées restent celles des contrats.
- Si un document manque, une nouvelle fiche peut être conservée en brouillon : lignes manuelles et notes, cotisations à préparer à la reprise. La liste affiche « À calculer » et « Reprendre ». Ce brouillon ne constitue pas une fiche validée ni un PDF final.
- L’ajout d’un collaborateur depuis une nouvelle fiche revient à cette fiche avec la bonne personne, le mois et la date de paiement. Le coût horaire des projets devient facultatif pour préparer la paie ; le formulaire explique la valorisation à zéro lorsqu’il reste vide.

## Vérifications

125 tests unitaires ciblés passent, ainsi que TypeScript. Recettes navigateur avec données synthétiques :

- `payroll-first-payslip-journey.mjs` : Edge et WebKit, 320/390/1440 px, première configuration complète jusqu’à l’enregistrement, conservation du salaire, panne sur la deuxième part de pension et reprise sans doublon, brouillon/reprise et collaborateur créé depuis la fiche.
- `payroll-repair-journey.mjs` : Edge et WebKit, 390/1440 px, base effacée, date annuelle invalide, correction ciblée, conservation d’une base manuelle et enregistrement.
- `payroll-pension-corrections-journey.mjs` : 320/390/1440 px, salaire annuel isolé, contrat incomplet puis corrigé, deux parts, correction comptable, recalcul et enregistrement.
- `payroll-guided-journey.mjs` : 320/390/768/1024/1440 px, parcours déjà configuré, calcul tardif rejeté, modification, panne/reprise et isolation entre collaborateurs.
- `employee-wizard-journey.mjs` : Edge et WebKit, 320/390/844/1440 px, validation, aller-retour, conservation et nouvelle tentative après échec.

Ces recettes n’attestent pas une installation sur iPhone ou un profil client réel. Les règles fiscales, les taux du moteur, les contrôles de validation native et le schéma SQLite 59 restent inchangés. Le logiciel n’est pas présenté comme certifié Swissdec.

Références de l’aide consultées le 11 septembre 2026 : [AVS, cotisations 2026](https://www.ahv-iv.ch/p/2.01.f), [OFAS, financement de la prévoyance professionnelle](https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle). Aucun taux contractuel, décision annuelle ou justificatif n’est inventé.

## Distribution

Publié le 11 septembre 2026. Source compilée : `39af84e5e0fbb0e07454e3c3f2fdedb008c7dd9f`.

- Installateur `Zentra_1.54.0_x64-setup.exe` : 22 780 650 octets, SHA-256 `2BDD3326EFD55326D1DA80D5A5386C9F6EDD8C3ECB741069BCFCC784565392DE`.
- Exécutable embarqué : SHA-256 `9DDD851B00B7FE4C67DFBB91B856BA0BA5C92A0E50D69AC1E96B06EA88760069`.
- [GitHub v1.54.0](https://github.com/leartshbj1/zentra/releases/tag/v1.54.0), accès anticipé, avec installateur, signature et empreinte. Digest public GitHub comparé au fichier compilé.
- Installateur, signature et empreinte téléchargés publiquement depuis Supabase et comparés aux octets préparés. Vérification Ed25519 réussie avec la clé de confiance existante.
- Canal `latest-windows.json` public vérifié en 1.54.0, URL et signature concordantes. Ancien canal conservé sous `latest-windows-before-1.54.json` et comparé à l’original ; canal partagé `latest.json` inchangé.
- [Site Zentra](https://elyko.alb-leart1.chatgpt.site) publié, version 120, source `9d3c9e1c6631571a345b8e23d9b15ba579257ff3`, déploiement `appgdep_6aa43906a43c8191b9e77781a7cc5c25` réussi. Le lien Windows et son empreinte correspondent au nouvel installateur.

Les deux tests natifs `incomplete_employee_can_calculate_a_draft_without_statutory_contributions` et `atomic_payslip_save_rolls_back_create_and_update_on_contribution_error` réussissent sur cette source. Report ciblé dans le dossier principal : TypeScript et la recette complète première fiche Edge/WebKit passent aussi sur un serveur neuf ; les travaux natifs et la classification des revenus déjà présents ont été conservés.

Authenticode indisponible. Installation neuve et mise à niveau d’un profil client réel non attestées. Cette livraison publie Windows ; aucun nouvel IPA ni paquet macOS n’a été généré. Les améliorations de l’interface mobile sont dans le code partagé, testées dans WebKit.
