# Pagination des bilans — correction après 1.90.6

Le 27 septembre 2026, 22 h 50 (Europe/Zurich). Code final `4f9ca69074592abc5f7624c338886cbdb659aad8`, précédé de `bb266a50076b366dda389a993e7678d83754b3e9`. Ce lot n'est pas dans les paquets 1.90.6 publiés et n'est pas installé sur le PC.

## Problème et correction

Le bilan exporté en paysage pouvait laisser « Fonds propres » seul en fin de page. Les mesures des lignes utilisent maintenant la vraie variante de police, y compris le gras. Chaque rubrique réserve la place de sa première ligne. Si une description dépasse une page entière, elle commence sous la rubrique puis continue avec ses en-têtes de colonnes. Le contrôle d'équilibre reste avec le total des passifs.

Seule la composition des PDF personnalisés est modifiée : aucun calcul comptable, montant, enregistrement ou migration de base de données. Le rendu historique sans composition est conservé.

## Vérifications sur la source finale

- 62 tests natifs réussis : 21 de composition, 4 de comptabilité, 28 de ventes, 7 de paie et 2 de rapport de projet. Un test de rapport explicitement ignoré exige une fixture externe ; il n'est pas compté comme réussi.
- 56 combinaisons de police Inter/Literata, orientation portrait/paysage, taille 9/12 points et longueur d'introduction. Les douze rubriques restent avec leur première ligne et le contrôle avec son total.
- Cas extrême : description de 400 répétitions, 80 comptes supplémentaires et rubrique vide. Les contenus de début et de fin sont présents, les en-têtes sont répétés et aucun compte n'est perdu.
- Neuf documents fictifs, 41 pages rendues et examinées après la correction finale ; 36 642 caractères contrôlés dans les limites des pages. La grande taille de texte peut toujours produire du blanc en fin de page pour garder ensemble les éléments.

Preuves locales : `outputs/pdf-pagination-20260927/`, notamment `render-proof.json`, `visual-review.json`, les cinq journaux de tests et les images de contrôle. Les PDF de ce dossier sont des intermédiaires de recette, pas des documents client.

## Vérification cloud distincte

CircleCI Windows **155**, terminé avec succès à 22 h 45, utilise **bb266a50**. Il confirme le premier correctif de rubriques et les cinq suites ciblées, mais n'inclut pas les deux derniers ajustements de `4f9ca690` (en-têtes répétés dans une très longue ligne et total avec contrôle). Ces ajustements sont prouvés par les tests locaux ci-dessus ; ne pas les attribuer au job 155. Aucun installateur produit ni publié par ce job.

Les appareils physiques, le sélecteur de fichier natif et le binaire client de cette correction restent à valider. La réussite du rendu ne rétablit ni les comptes Supabase ni la signature de distribution Windows.
