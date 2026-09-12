# Zentra 1.55.0 — création de paie et reprise des enregistrements

Publié le 12 septembre 2026 en accès anticipé Windows. Source compilée : `a303f0777828cbe698beaa054bbcaafa65dd4706`. Schéma SQLite 59 ; identifiant d'installation `ch.helvichantier.desktop` conservé.

- La saisie du salaire affiche le montant du mois et la prochaine action. Les réglages détaillés sont regroupés ; chaque correction ouvre le guide approprié. Le net calculé a une seule sauvegarde de fiche.
- Les salaires horaires se calculent depuis les heures et le tarif. Un guide explique les montants soumis aux assurances. Les bases manuelles sont revérifiées après changement du brut.
- Un brouillon peut être repris et corrigé sous le même identifiant. Les cotisations déjà persistées sont protégées.
- Les enregistrements réussis suivis d'une lecture interrompue sont récupérés sans relancer les commandes. Cela couvre les entités, le planning et le pointage, les devis/révisions, corrections de facture, acomptes/solde et règlements.
- Les dates et notes des factures liées sont enregistrées avant de rejoindre leur dossier. Le paiement propose le solde restant et explique les erreurs de montant ou de date.

## Vérification

117 fichiers / 960 tests d'interface, TypeScript et compilation réussis. 28 scénarios de paie Edge/WebKit, 24 de récupération commerciale, 8 de factures liées et 4 de création de documents ont réussi. Les parcours ciblés sont également vérifiés après report dans le dossier principal, en conservant ses autres travaux.

La campagne native de cette base a donné 647 réussites et 2 recettes HTTPS ignorées. Les tests natifs ciblés du brouillon, de la paire acompte/solde avec PDF et sauvegarde, de la correction d'une facture payée et de l'atomicité du règlement ont réussi. Le détail figure dans `QUALITE-APP-2026-09-12.md`. Les recettes navigateur sont synthétiques.

## Artefacts et publication

- Installateur : `Zentra_1.55.0_x64-setup.exe`, 22 778 945 octets.
- SHA-256 : `5ACBEAAFB4BD04FB3E0357681C882E93CE1725183F65D4E205E1C9ABD6FE68DC`.
- Exécutable embarqué : SHA-256 `E96B6B43D171E5C1FF058646128F6194E59D51AE970506945CD23062EBEA2461`.
- [Publication GitHub v1.55.0](https://github.com/leartshbj1/zentra/releases/tag/v1.55.0), avec signature Tauri et empreinte ; digest GitHub concordant.
- Installateur, signature et empreinte téléchargés publiquement depuis Supabase. Vérification Ed25519 réussie avec la clé de confiance existante.
- `latest-windows.json` public vérifié en 1.55.0, URL et signature concordantes. Le précédent manifeste est conservé dans `latest-windows-before-1.55.json` et `latest-windows-1.54.0.json`. Le canal partagé `latest.json` est inchangé.
- Page de téléchargement publiée via Sites : version 121, source `4ce11f1d1d0a975631228fd6ccf7156e6301857b`, déploiement `appgdep_6aa4b00ac05c8191991b6c97564ad2a3` réussi. Le HTML public contient le lien Windows 1.55 et son empreinte.

Authenticode indisponible. Une installation ou mise à niveau sur un profil client réel n'est pas attestée. La vérification WebKit ne remplace pas une installation iPhone. Aucun nouvel IPA ni paquet macOS/Android n'est inclus dans cette publication.
