# Paie simplifiée et répertoire suisse — 10 septembre 2026

Recherche et recette de la branche de développement. Le périmètre exact du portage Windows est décrit dans [Zentra 1.49.0](../RELEASE-1.49.md) ; les anciens résultats cités ci-dessous ne sont pas des tests de son installateur.

## Parcours livré dans le code

La fiche se prépare en trois étapes : personne et mois, salaire, vérification. Le salaire habituel et les cotisations proposées depuis le profil sont repris au premier passage. Revenir en arrière ne réactive pas des cotisations volontairement décochées. Changer de personne réinitialise les éléments personnels.

Une aide « Ma première fiche » explique le brut, les retenues, le net et la différence entre enregistrer une fiche et effectuer un virement. Les corrections du contrat, des cumuls annuels, des assurances et des cotisations se font dans le même dialogue. Le formulaire de salaire reste monté mais masqué : ses montants, ses notes et ses étapes restent conservés lors de ces corrections.

Les contrôles affichent une explication en français. Les messages originaux restent disponibles dans « Voir le message détaillé ». Les problèmes de contrat, de début d’année et de primes disposent de raccourcis vers les champs correspondants. Une erreur d’enregistrement reçoit le focus, y compris en bas d’un long formulaire mobile. Les problèmes portant sur les comptes généraux des salaires renvoient aux réglages de Comptabilité ; ce parcours ne lance pas la régularisation globale de l’historique comptable.

Le salaire existant n’est pas écrasé par la correction du collaborateur. Les cumuls d’ouverture n’utilisent zéro qu’après une réponse explicite. Les enregistrements relisent les informations concernées et refusent de remplacer une fiche ou des réglages modifiés entre-temps. Une modification des assurances remet `fiduciaryValidated` à faux. Aucun choix dans le répertoire ne souscrit une assurance ou ne valide la configuration financière.

## Répertoire intégré

Le fichier `desktop/src/swissPayrollDirectory.json` contient **357 entrées**, avec source et numéro. Les agences AVS sont des entrées distinctes : ce total n’est pas un nombre d’entreprises d’assurance distinctes.

| Groupe | Entrées | Source primaire et périmètre |
| --- | ---: | --- |
| Caisses AVS cantonales | 26 | [Répertoire AVS/AI](https://www.ahv-iv.ch/fr/Contacts/Caisses-cantonales-de-compensation), consulté le 10.09.2026 |
| Caisses AVS professionnelles et agences | 64 | [Répertoire AVS/AI](https://www.ahv-iv.ch/fr/Contacts/Caisses-de-compensation-professionnelles), consulté le 10.09.2026 |
| Caisses fédérales AVS | 2 | [CFC](https://www.ahv-iv.ch/fr/Contacts/Caisse-f%C3%A9d%C3%A9rale-de-compensation-CFC) et [CSC](https://www.ahv-iv.ch/fr/Contacts/Caisse-suisse-de-compensation-CSC) |
| Caisses d’allocations familiales | 202 | [OFAS : registre des caisses](https://www.bsv.admin.ch/fr/allocations-familiales-organisation), colonne d’admission 2026 du registre du 01.01.2026 |
| Assurance accidents | 22 | Suva et 21 assureurs inscrits au [registre OFSP](https://www.bag.admin.ch/fr/lassurance-accidents-assureurs-et-surveillance), état au 01.07.2026 |
| Assurance collective salaire en cas de maladie | 22 | Destinataires avec couverture IJM publiée dans le [répertoire Swissdec](https://www.swissdec.ch/fr/data-receiver), **liste partielle** |
| Caisses de pension suisses | 19 | Fondations publiées dans le même [répertoire Swissdec](https://www.swissdec.ch/fr/data-receiver), **liste partielle** |

La recherche accepte noms sans accents, numéros et cantons. Le canton de l’entreprise sert à présenter d’abord les entrées correspondantes ; il ne détermine pas automatiquement l’affiliation. La saisie libre reste possible dans les cinq champs, notamment pour une fondation LPP absente. Les caisses-maladie personnelles LAMal ne sont pas confondues avec le contrat collectif IJM de l’employeur. Le périmètre et la date de vérification sont visibles dans l’interface. Le répertoire est embarqué et consultable sans réseau ; il ne prétend pas se mettre à jour automatiquement depuis les registres.

L’import reproductible des CAF se trouve dans `desktop/scripts/import-payroll-family-directory.py`. Il lit les 84 pages et 2 556 lignes historiques du [PDF OFAS 2026](https://www.bsv.admin.ch/dam/fr/sd-web/OrD7uoqkgs1z/FamZG_FAK-Nummer_CH_2026.pdf), conserve les admissions 2026, regroupe par numéro et rassemble les cantons ainsi que les alias linguistiques. Empreinte du PDF : `539df6c88e429dfe785b7a9fe46443c9d623987e58b5f9b84956456d043bb5d5`.

## Réglages guidés et limites

- Le bouton des taux suisses ajoute les lignes AVS/AI/APG et AC manquantes depuis le profil natif CH-2026. Les lignes présentes, y compris désactivées, ne sont pas écrasées. Une couverture personnalisée équivalente ne reçoit pas une deuxième série officielle concurrente.
- Les modèles AAP, AANP, CAF, IJM et LPP demandent les valeurs du contrat réel, sa référence et ses dates. Le plafond accidents 2026 est préparé depuis le référentiel existant ; aucune prime n’est déduite du nom de l’assureur.
- La LPP guidée utilise un montant mensuel confirmé, pour une personne, une part et une couverture précises. Elle ne calcule pas une cotisation universelle à partir du salaire mensuel.
- Les cotisations nouvellement préparées se sélectionnent ensuite dans le salaire ; une IJM ou un impôt à la source ne sont pas appliqués par supposition. Le choix des comptes d’une cotisation existante est conservé lors de sa modification, même lorsqu’il est vide ou devenu indisponible.
- Le moteur conserve sa précision actuelle de deux décimales en pourcentage. Un taux comme **1,452 % est refusé explicitement** : il n’est jamais arrondi à 1,45 %. Cette évolution ne résout pas la prise en charge native des primes à davantage de décimales.
- La préparation guidée des contrats couvre 2026. Les cas particuliers, les règles CCT, les impôts à la source individuels et les cotisations non standard restent soumis aux réglages et contrôles existants. Le répertoire Swissdec ne donne à Zentra aucune certification Swissdec ni transmission ELM.

## Vérification

Les tests navigateur emploient des données synthétiques et des services natifs simulés ; ils ne prouvent pas une installation Windows ni une comptabilisation réelle. Aucun moteur natif n’a été modifié pour cette simplification.

- Suite complète de l’interface : **1 000 tests passent** dans 126 fichiers. Les 43 tests ciblés couvrent notamment le répertoire, les taux exacts et les propositions de cotisations.
- Nouveau parcours `payroll-simple-journey.mjs` : corrections du contrat et des cumuls, recherche AVS/CAF/LAA, saisie libre LPP, conservation des notes, échec puis reprise, protection contre le double envoi, identité conservée après reprise et modification d’une prime. Cas supplémentaire avec taux fédéraux absents, puis préparation répétée sans doublon.
- Parcours guidé à 320, 390, 768, 1 024 et 1 440 pixels : retour entre étapes, absence de débordement, calcul lent périmé, erreurs lisibles, sauvegarde puis changement de collaborateur. Décocher toutes les cotisations puis revenir en arrière ne les réactive pas.
- Parcours formulaire aux mêmes cinq largeurs : recherche/pagination, récupération en lecture seule après écriture, calculs périmés et reprise des paramètres.
- Six scénarios de bases salariales à 320, 390 et 1 440 pixels : allocations légales, preuve manquante, primes cotisables et montant envoyé au moteur.
- Parcours de bout en bout de l’interface aux cinq largeurs : calcul, refus/reprise, comptabilisation simulée, paiement simulé, export/partage simulés et focus clavier.
- Compilation TypeScript et bundle de production vérifiés. Le lint des huit nouveaux composants et helpers passe sans erreur. Le bundle conserve les avertissements de taille des gros modules préexistants.

Captures et rapports : `.qa/payroll-simple/`, `.qa/payroll-guided/` (dont `basis-report.json`), `.qa/payroll-forms/` et `.qa/payroll/`. Les captures du contrat, de l’historique, du répertoire et de la vérification finale ont été inspectées sur mobile et ordinateur.

## Distribution

Cette évolution est préparée dans le chantier de développement. Elle dépend du parcours de paie en cours et du schéma natif 67 déjà présent dans ce checkout. Elle ne doit pas être copiée seule dans l’installateur 1.48.0 construit sur le schéma 59. La compatibilité des historiques partagés entre versions et la recette de distribution restent à terminer avant sa livraison aux clients. Aucun nouvel installateur ni canal de mise à jour n’a été publié pendant cette modification.
