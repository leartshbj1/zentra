# Interface du premier client — 27 septembre 2026

Cette note décrit l’extension locale des paramètres, de la messagerie, du bouton d’assistant et de l’état de synchronisation. Les parcours navigateur fournis passent dans leur périmètre. Le verdict de revue **ship** est limité à la correction du message d’attente demandant explicitement d’enregistrer puis de quitter les paramètres. Il ne valide pas l’application entière ni une livraison native.

## Périmètre et références

Le travail prolonge l’identité Apple sobre de Zentra Gestion, en mode **Operate** : lire un réglage, modifier un modèle, préparer un e-mail et comprendre une attente de synchronisation. Il est réalisé en code, sans nouveau monde visuel ni nouvel actif raster.

Les autorités existantes restent [PRODUCT.md](../desktop/PRODUCT.md), [DESIGN.md](../desktop/DESIGN.md) et son [sidecar](../desktop/.impeccable/design.json). Cette note les complète sans les remplacer. La passe documentaire n’écrit que le présent fichier ; elle ne modifie aucun composant, catalogue, token ou contrat de design.

Sources examinées : `OutgoingMailPanel.tsx`, `outgoingMail.ts`, `outgoing-mail.css`, `SettingsCategory.tsx`, `CompanySettingsSync.tsx`, l’intégration dans `WorkspaceApp.tsx`, `companySync.tsx`, `companySyncPresentation.ts`, `ZentraAssistant.tsx`, `assistantContext.tsx`, `assistant.css`, les catalogues `translationsOutgoingMail.ts`, `translationsCompany.ts` et leur raccordement. Les autres changements présents dans ces fichiers ne sont pas couverts par cette revue d’interface.

## Comparaison avec le design établi

| Référence existante | Extension observée | Portée |
| --- | --- | --- |
| « Précision calme » : index stable, feuille de travail opaque, typographie système, accent vert | Les paramètres gardent leur index et leur feuille ; la messagerie reprend les champs et boutons partagés, avec les rôles clair et sombre existants. | Les cinq captures relues ne montrent pas de remplacement de l’identité. |
| Actions lisibles, groupes capables de revenir à la ligne, cibles tactiles | Les trois onglets e-mail conservent leur largeur intrinsèque et une hauteur minimale de 44 px. Les boutons d’insertion de variable ont aussi un minimum CSS de 44 px. Les groupes se réorganisent sur petit écran. | La mesure automatisée de hauteur et de texte non coupé porte sur les onglets ; elle ne constitue pas une mesure de tous les contrôles de l’application. |
| Barre supérieure et feuilles sans ombre décorative ; hiérarchie par espacement et séparateurs | L’assistant occupe un emplacement de 44 × 44 px dans la barre supérieure. Sa variante intégrée est statique, transparente et sans ombre. | La réservation est vérifiée dans l’espace de travail. Le repli flottant reste présent dans le composant lorsqu’aucun emplacement n’est fourni. |
| Un état garde un libellé compréhensible | « Nouveautés en attente » est distinct de « Réception en cours ». Le détail de l’attente explique l’action nécessaire. | Aucune activité de synchronisation n’est inventée pour remplir l’écran. |
| Documents et logos client indépendants des couleurs de l’interface | L’aperçu de signature conserve son support blanc ; le nom, le message, les variables et la pièce jointe client ne sont pas traduits avec l’interface. | Le logo visible dans les preuves est une donnée fictive du banc de test, pas un nouvel actif de marque. |

Les rayons, la famille système, les gris de travail et le vert existants restent les références. Les ajustements de mail et de barre supérieure sont locaux ; ils n’ajoutent pas de primitive globale ni de nouvelle règle pour tous les écrans.

## Comportements documentés

**Messagerie en FR/DE/IT/EN.** Les libellés, aides, actions, états et erreurs mail connues utilisent le catalogue d’interface. Les erreurs de variable inconnue traduisent leur enveloppe tout en conservant l’identifiant tel que saisi. Les objets, corps de message, noms et adresses client, identifiants de variables et noms de pièces jointes restent verbatim. Les preuves montrent notamment un formulaire italien contenant un message client français : c’est le comportement attendu. Elles ne démontrent pas la traduction de chaque erreur possible d’un fournisseur SMTP.

**Consultation des paramètres et réception.** Les trois formulaires de base explicitement déclarés recevables — entreprise/facturation, adresse structurée du créancier et règles de travail — permettent la réception lorsqu’aucune saisie ou autre blocage ne la retient. Après réception simulée, les valeurs sont recréées depuis l’espace reçu et la rubrique active est conservée. Changer de rubrique révèle son début sous la barre fixe, y compris sur ordinateur.

**Protection des brouillons.** Toute saisie dans l’enveloppe des paramètres marque une protection qui demeure jusqu’à la sortie des paramètres. Le contrôle tient aussi compte des brouillons d’état et des opérations en cours. Un brouillon dans une rubrique ensuite cachée continue de bloquer le remplacement. Enregistrer une autre rubrique ne lève pas cette protection : cet enregistrement partiel ne garantit pas que tous les formulaires ont été sauvegardés. Les autres dialogues et éditeurs conservent leurs protections existantes.

Le message français exact est :

> Enregistrez vos modifications, puis quittez les paramètres pour recevoir les nouveautés de votre équipe.

Il est présent dans l’indicateur et dans le panneau de synchronisation. Ses traductions allemande, italienne et anglaise figurent dans `translationsCompany.ts`. Le parcours de paramètres relit et compare le texte français ; il ne rejoue pas ce scénario dans les quatre langues. La réception reprend après la sortie lorsque les blocages sont levés. Cela ne signifie pas qu’un brouillon non enregistré est automatiquement sauvegardé en quittant les paramètres.

**Assistant.** Le bouton dispose d’une place réservée dans la barre d’outils et d’un nom accessible traduit. Son ouverture puis sa fermeture sont vérifiées. Ce travail n’atteste ni la traduction complète du dialogue d’assistant ni le fonctionnement d’un modèle local sur un appareil installé.

## Preuves et revue

Le [parcours automatisé](../desktop/tests/first-client-interface-journey.mjs) utilise des données fictives, bloque les requêtes hors de l’origine locale et active la réduction du mouvement. Les résultats fournis sont :

| Preuve | Ce qu’elle établit | Limite |
| --- | --- | --- |
| [proof.json](../desktop/.qa/first-client-interface/proof.json) | 24 combinaisons mail : Chromium via Edge et WebKit × 320/390/1440 px × FR/DE/IT/EN. Libellés attendus, onglets ≥ 44 px sans coupure, erreur de variable localisée, brouillon conservé et contenu client intact. Quatre parcours supplémentaires vérifient paramètres et assistant à 390/1440 px. | Mode sombre à 320/390 px, clair à 1440 px : les deux thèmes ne sont pas croisés avec chaque largeur. Le contrôle de débordement global a lieu dans le composeur puis après la sortie des paramètres. |
| [settings-review-proof.json](../desktop/.qa/first-client-interface/settings-review-proof.json) | Les quatre reprises Chromium/WebKit à 390/1440 px passent, y compris `draftProtectedAfterPartialSave`, le texte d’attente exact, les brouillons visibles/cachés, la reprise après sortie et l’assistant intégré. | Reprises des quatre scénarios paramètres, pas quatre langues supplémentaires ni quatre appareils physiques. |
| Compilation web/TypeScript et 18 tests ciblés | Réussite communiquée par la passe d’implémentation pour ce lot. | Non relancés par cette passe documentaire ; aucune compilation native n’en est déduite. |
| Relecture indépendante | Disposition finale **ship** limitée à la correction du message « enregistrer puis quitter les paramètres », avec les quatre reprises de protection partielle passées. | Ce verdict ne certifie pas tous les parcours métier ni les vingt points de l’audit du premier client. |

Les cinq captures suivantes ont été ouvertes et comparées aux références existantes :

- [Paramètres Chromium, 1440 px](../desktop/.qa/first-client-interface/settings-chromium-1440.png) : index et feuille, assistant dans la barre supérieure, attente et instruction visibles.
- [Paramètres WebKit, 390 px](../desktop/.qa/first-client-interface/settings-webkit-390.png) : détail d’attente lisible sur plusieurs lignes dans la feuille mobile.
- [Messagerie allemande, Chromium, 320 px](../desktop/.qa/first-client-interface/mail-chromium-320-de.png) : onglets lisibles, formulaire sombre en une colonne.
- [Messagerie anglaise, Chromium, 1440 px](../desktop/.qa/first-client-interface/mail-chromium-1440-en.png) : formulaire clair en deux colonnes et actions identifiables.
- [Composeur italien, WebKit, 390 px](../desktop/.qa/first-client-interface/composer-webkit-390-it.png) : libellés italiens, message client français conservé, signature sur papier blanc et PDF nommé. Cette capture de viewport n’expose pas tout le bas du dialogue.

Les mentions françaises « Aperçu · entreprise et adresses fictives » et « Préparer un e-mail » sur les captures mail appartiennent au banc de test. Elles ne sont pas des libellés de la surface mail livrée.

## Dérive préexistante et limites

`DESIGN.md` décrit `workspace-atelier.css` comme le dernier import. Dans le `main.tsx` actuel, `onboarding-journey.css`, `workspace-personalization.css` et `brand-identity.css` viennent ensuite. Cet écart documentaire existe avant ce lot et n’a pas été corrigé. La version native 1.83.0 citée par `PRODUCT.md` est une référence historique ; le manifeste inspecté indique 1.90.2, sans prouver quelle version est installée chez un client.

Le design existant mentionne aussi des textes métier non traduits et une coupure héritée d’« Einstellungen » à 320 px. Ces constats historiques restent hors de la correction ciblée des onglets mail ; aucune clôture générale de traduction ou d’accessibilité n’est annoncée.

Ce lot ne prouve pas un envoi SMTP réel, une livraison au destinataire, une synchronisation de production entre deux comptes, la résolution des erreurs HTTP 500, une recette complète du premier client, un audit exhaustif clavier/lecteur d’écran/zoom, ni une installation ou publication Windows, macOS, iOS ou Android. Les captures WebKit sont des preuves navigateur. L’acceptation éventuelle d’un e-mail par un serveur SMTP reste distincte de sa réception par le destinataire.

Les références produit et design ont été préservées lors de cette passe. Les points restant à traiter relèvent du [suivi de préparation du premier client](AUDIT-PREMIER-CLIENT-SUIVI.md), pas d’une déclaration de disponibilité globale.
