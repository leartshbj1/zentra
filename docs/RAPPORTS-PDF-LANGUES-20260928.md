# Rapports de projet — langue des pages suivantes

Correction du 28 septembre 2026, **non publiée et absente de 1.90.6**.

La langue sélectionnée dans Gestion accompagne maintenant le rapport envoyé au moteur PDF. Les en-têtes des pages suivantes et les rubriques vides suivent le français, l’allemand, l’italien ou l’anglais. Les noms, notes, références et contenus du client restent inchangés. Les anciennes demandes sans champ de langue restent françaises ; les valeurs de langue non prises en charge sont refusées.

Ce lot ne traduit pas les autres familles de documents ni les diagnostics natifs inconnus. Il ne modifie aucun calcul financier, donnée enregistrée, droit d’accès ou filtre du dossier client. Les autres utilisateurs du moteur conservent leur libellé antérieur.

## Preuves

- Huit tests frontend de rapport, TypeScript et build Vite réussis ; les exclusions du dossier client et la préservation des notes sont toujours vérifiées. Avertissement préexistant de gros chunks conservé.
- 29 tests Rust exécutés localement : quatre Rapports, 21 Composition et quatre Comptes. Un test Rapports exigeant une fixture externe est explicitement ignoré, sans le compter comme réussi.
- Quatre PDF natifs fictifs, huit pages rendues avec Poppler et relues. Les 65 lignes de chaque rapport sont présentes exactement une fois, les en-têtes correspondent à la langue et les caractères restent dans la page. Aucun document client utilisé.
- `outputs/project-report-languages-20260928/` contient les trois journaux natifs, les quatre exemples et `rendered/proof.json` (empreintes des sources et des PDF). `desktop/.qa/project-report-languages-{unit,build}.log` conserve les résultats frontend. Contrôle reproductible : `desktop/tests/verify-project-report-languages.py`.

Ces exports proviennent du moteur Rust de test, pas de l’application installée ou d’un sélecteur système. Aucun compte distant ni appareil physique validé ; les blocages de l’hébergement et de la signature Windows restent ouverts.
