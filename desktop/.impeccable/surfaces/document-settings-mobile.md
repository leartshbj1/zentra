# Réglages Documents et import bexio — téléphone

Mode : **Operate**. Extension ordinaire du monde existant « précision calme », réalisée dans le code le 27 septembre 2026. [PRODUCT.md](../../PRODUCT.md) et [DESIGN.md](../../DESIGN.md) restent les autorités produit et visuelle. Aucun nouveau monde visuel, comp raster approuvé ou token global n'est introduit.

## Intention

Voir son document dès l'arrivée dans les Réglages sur téléphone, puis ouvrir les outils utiles sans perdre le brouillon. Préparer une reprise bexio dans une présentation compacte et rendre une vérification d'entreprise échouée compréhensible et réessayable. Conserver l'accès à l'atelier complet et ses outils sur bureau.

## Composition et comportement

- Jusqu'à 900px, le document est la vue initiale. Un sélecteur natif remplace les quatre choix de type côte à côte ; l'action d'ouverture du grand atelier garde un nom accessible traduit. L'introduction interne et les titres répétés dans les Réglages sont masqués.
- Le groupe « Mon document / Mes réglages » change la région visible sans remonter l'éditeur. La sauvegarde reste accessible. Les groupes peuvent revenir à la ligne : à 320px, la sauvegarde occupe une ligne supplémentaire ; à 390px et taille ordinaire, la bande reste compacte. À 200%, les libellés conservent des mots entiers, même si cela repousse l'aperçu sous le premier écran.
- Les sélecteurs, boutons du groupe mobile et actions d'import gardent une hauteur minimale de 44px ; le sélecteur de document utilise un texte de 16px. Les boutons grandissent avec leur contenu. Le contrat applique la règle existante **Intrinsic Control Rule**, sans réduire le texte pour faire tenir une rangée.
- Sur bureau, les outils et l'entrée vers le grand atelier sont conservés. Le changement de vue ne doit pas effacer l'historique, le brouillon, la reprise après échec de sauvegarde ou l'accès aux exports.
- L'import garde ses choix Clients, Fournisseurs et catalogue. La préparation de l'export bexio est repliée dans un détail ouvrable ; l'avertissement sur les données non reprises reste visible. Les choix longs se réorganisent entre les mots ; le libellé allemand du catalogue est « Artikel und Leistungen ».
- L'échec de vérification de l'entreprise reste affiché avec une action « Réessayer la vérification » et la précision qu'aucune donnée n'a été ajoutée. L'action occupe sa hauteur réelle, avec un espace avant les choix d'import. Le chargement expose son statut. La portée d'entreprise, l'exclusion des doublons, les restrictions et la confirmation explicite restent nécessaires avant l'import.

## Identité conservée

Le rendu demeure celui de Gestion : typographie système, feuilles opaques, fonds neutres clair/sombre, vert pour les actions et la sélection, séparateurs et dévoilement progressif. Le sélecteur natif et les états pressés explicites servent l'usage tactile. Aucun média décoratif, matériau simulé ou animation supplémentaire n'est ajouté.

Les documents d'exemple et leurs polices/couleurs appartiennent au document imprimé, distinct de l'interface. Les aperçus restent identifiés comme fictifs et sans valeur. Les anciennes valeurs locales de l'éditeur ne deviennent pas de nouveaux tokens partagés.

Les nouvelles entrées Documents/import et l'entrée de l'atelier sur bureau utilisent le français, l'allemand, l'italien et l'anglais. La traduction complète des outils avancés demeure différée ; cette extension ne l'annonce pas comme terminée.

## Sources et validation bornée

Implémentation : [DocumentDesignStudio.tsx](../../src/DocumentDesignStudio.tsx), [DocumentDesignStudio.css](../../src/DocumentDesignStudio.css), [BexioImportPanel.tsx](../../src/BexioImportPanel.tsx), [BexioImportPanel.css](../../src/BexioImportPanel.css) et [translationsDocumentSettings.ts](../../src/translationsDocumentSettings.ts).

La [première relecture](../../.qa/document-settings-mobile/finish-review.md) conclut **fix** pour trois points : chevauchement du bouton de nouvelle vérification à 200%, mots coupés dans les contrôles, traductions manquantes à l'entrée. Le [verdict final](../../.qa/document-settings-mobile/finish-verdict.md) les marque tous résolus et conclut **ship, limité à ces trois corrections**. Il ne certifie pas toute la surface ni toute l'application.

| Preuve locale | Portée constatée |
| --- | --- |
| [Réglages ordinaires](../../.qa/document-settings-mobile/proof.json) | 24 configurations : Chromium/WebKit × 320/390/1440px × FR/DE/IT/EN ; brouillon conservé, nouvelle vérification, libellé fournisseur, import borné à l'entreprise et absence de débordement. 390px est en clair ; 320/1440px en sombre. Les 36 captures ordinaires couvrent FR/DE et trois états ; les six planches ont été régénérées. |
| [Texte à 200%](../../.qa/document-settings-large-text/proof.json) | Quatre configurations : Chromium/WebKit × DE/EN à 320px. Les contrôles gardent des mots entiers et la nouvelle vérification reste séparée. 16 captures, dont quatre vues centrées sur tout le groupe de changement de vue. |
| [Atelier Chromium](../../.qa/document-workbench-chromium/report.json) et [WebKit](../../.qa/document-workbench-webkit/report.json) | Huit parcours, à 320×568, 390×844, 844×390 et 1440×1000 par moteur : historique, navigation dans 25 outils, focus des outils imbriqués, bilan, reprise/raccourci de sauvegarde, exports et sauvegarde/rechargement. 16 captures. |

Le corpus actuel compte **68 captures**, hors anciennes images `FAILED-*` et planches de contact. Une capture défilée atteste son état nommé, pas toute la page. Le [détecteur](../../.qa/document-settings-detector.json) conserve cinq avertissements et 66 avis, principalement liés aux styles historiques et aux polices PDF proposées à l'utilisateur ; ce n'est pas un résultat sans avertissement.

Les données et commandes natives des parcours sont simulées. Ces preuves ne valent pas import bexio réel, certification du moteur PDF, validation sur appareil physique, livraison native ou publication. Le [contrôle documentaire](../../.qa/document-settings-mobile/documentation-review.md) précise les limites et la préservation des autorités globales.
