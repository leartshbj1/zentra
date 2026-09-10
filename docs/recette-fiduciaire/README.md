# Recette comptable à faire examiner

Le dossier `output/pdf/Zentra-dossier-recette-fiduciaire.pdf` contient cinq pages : périmètre, TVA et bilan, acompte et rapprochement bancaire, paie et certificat annuel, procès-verbal et sources officielles. Il utilise uniquement des entreprises, opérations et salariés fictifs.

`attendus.json` conserve les résultats indépendants en centimes. Le script `scripts/build-fiduciary-review-package.py` recalcule et vérifie les égalités avant de produire les deux fichiers. Les cinq pages du PDF ont été rendues et contrôlées visuellement le 8 septembre 2026.

## État de la validation

Les valeurs d’`attendus.json` restent des **attendus indépendants**. Le premier scénario TVA/bilan a été exécuté le 10 septembre 2026 avec les commandes natives, dans un profil temporaire fictif : les neuf montants concordent, les neuf écritures sont équilibrées, le justificatif fournisseur est vérifié et les PDF/XML/ZIP ont été conservés. Voir [le compte rendu d’exécution](execution-2026-09-10.md).

Les scénarios acompte/banque et paie/certificat annuel restent à exécuter pour ce dossier. La matrice professionnelle reste à remplir. Aucun cabinet n'a été contacté et aucune validation comptable, fiscale ou Swissdec n'est acquise. Un essai des commandes natives ne constitue pas une recette sur deux appareils ni une validation de toute l’interface.

Pour chaque scénario :

1. Initialiser un profil de test indépendant, sans données de client réel, avec la version exacte de l'application et les réglages décrits.
2. Saisir et émettre les pièces par les parcours de l'application ; conserver les exports PDF, journaux, décomptes et XML applicables.
3. Comparer les sorties aux montants attendus ; consigner chaque écart et sa justification.
4. Remettre les pièces et ce dossier à la fiduciaire choisie par le titulaire. Faire préciser les méthodes, périodes et situations effectivement validées.

La paie comprend volontairement une différence entre net payé et net fiscal du certificat : l'IJM salariale n'est pas déduite au chiffre 9. Ses taux AANP/IJM et sa LPP sont des hypothèses de recette, à remplacer par les contrats du salarié pour un usage réel.

Les informations commerciales connues sont Shabija Leart, non assujetti à la TVA, `leartshabija@gmail.com`. L'adresse professionnelle et le domaine sont encore attendus.
