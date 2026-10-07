# Aperçu de configuration d’entreprise CH / US

Le composant `desktop/src/InternationalCompanySetup.tsx` prépare une configuration nationale pour une entreprise explicitement identifiée. Il est réutilisable, séparé du parcours natif actuel et non branché dans `WorkspaceApp`. Le desktop de ce checkout reste en version 1.46.1, avec les blocages financiers US décrits par l’audit. Cet aperçu ne crée ni facture ni écriture, ne transmet aucun formulaire fiscal et n’active aucune intégration.

## Contrat du composant

```ts
interface InternationalCompanySetupProps {
  organizationId: string;
  initialConfiguration?: CompanyConfiguration;
  onSave: (configuration: CompanyConfiguration) => Promise<void>;
  language?: CompanyLanguage;
  disabled?: boolean;
}
```

La référence d’organisation est validée. Une configuration initiale est relue par `validateCompanyConfiguration` et doit appartenir à cette organisation. Une valeur invalide ou associée à une autre entreprise produit un message bloquant localisé. Changer `organizationId` remonte le formulaire avec un brouillon neuf : le brouillon d’une entreprise ne part pas vers le callback d’une autre. `initialConfiguration` est une valeur initiale de montage ; pour remplacer une configuration initiale de la même organisation, le parent doit remonter explicitement le composant.

Le composant appelle uniquement `onSave`, après validation complète par le socle partagé. Il n’écrit pas dans le stockage local et ne choisit pas une API ou un contexte d’autorisation. Le serveur doit contrôler appartenance, rôle, version concurrente et invariants de l’entreprise avant persistance. Les refus du serveur sont présentés avec une possibilité de réessayer et conservation des valeurs saisies. Le texte d’une exception externe n’est pas exposé à l’utilisateur.

La création ne présélectionne ni pays, ni fuseau, ni méthode comptable, ni préfixe de facture. La langue d’entreprise reprend la langue fournie ou globale, sans changer cette dernière. Les quatre langues FR/EN/DE/IT disposent de textes locaux complets dans le composant. Aucune fonction `setAppLanguage` n’est appelée ; les noms, villes et adresses restent littéraux. La préférence d’entreprise et la langue d’affichage du formulaire sont deux valeurs distinctes.

Une configuration existante conserve son pays, sa devise et sa méthode comptable dans cet écran. La sélection du pays et de la méthode est désactivée en édition ; la devise est toujours dérivée du registre national. Un changement administratif ne passe pas par cet aperçu et doit être contrôlé également côté serveur.

## Les trois étapes

1. **Pays et entreprise / Country & business.** Choix explicite CH ou US, devise dérivée, adresse et subdivision du registre, EIN facultatif US. Les différences d’adresse sont définies par des adaptateurs de présentation regroupés, et validées par `validateAddress` du socle. Changer le pays efface les valeurs propres au pays (subdivision, code postal, EIN, fuseau et statut fiscal) sans traduire la rue ou la ville.
2. **Région et comptabilité / Regional & accounting.** Langue d’entreprise, fuseau IANA dans la liste nationale, choix cash/accrual explicite avec explication, préfixe de facture. La validation complète du socle intervient avant l’ouverture de la vérification ; une erreur sur une adresse ou un EIN renvoie vers le champ de la première étape. Les méthodes comptables choisies ne prétendent pas configurer ici des rapports fiscaux réellement branchés.
3. **Vérification / Review.** Résumé du pays, de la devise, de l’adresse littérale, des préférences, du préfixe et du statut fiscal. Le bouton enregistre la configuration, sans action financière. Pendant l’attente, navigation et champs sont désactivés et une garde synchrone empêche les soumissions répétées. Après succès, le bouton reste désactivé jusqu’à une modification ; après échec, une nouvelle tentative est possible.

Les étapes futures ne permettent pas de contourner la validation. Les boutons de navigation autorisent le retour vers une étape antérieure ; une nouvelle progression revalide le formulaire. Chaque contrôle utilise une étiquette native, avec `required`, `aria-invalid` et association d’aide/erreur quand nécessaire. Après une erreur, le premier champ concerné reçoit le focus. Le titre d’étape reçoit le focus lors d’un changement d’étape, sans vol du focus au premier montage ; le contour visible reste disponible au clavier.

## Fiscalité et limites affichées

À la création, `taxConfiguration.status` vaut toujours `unconfigured`. Aucun contrôle ne permet de le passer à `configured`. Une configuration initiale déjà déclarée `configured` conserve cette valeur sans la transformer en preuve fiscale. Le résumé précise qu’aucune règle fiscale n’est validée ou activée par cet aperçu.

Le message US est persistant après sélection du pays, dans chaque étape, et localisé dans les quatre langues. En anglais : **US pilot: billing needs a validated tax provider.** Le pays CH affiche que l’aperçu ne remplace pas le parcours suisse actuel. Les messages de succès et de vérification rappellent également que la facturation n’est pas activée et que la conformité des documents n’est pas validée.

Il n’y a ni taux US inventé, ni compte bancaire synthétique injecté dans une configuration réelle, ni certification revendiquée. Les fixtures du harness sont des données de recette distinctes des entreprises de production.

## Harness Vite et recette

Entrée : `desktop/tests/international-company-harness.html`, avec le vrai composant React dans `international-company-harness.tsx`. Il reprend `styles.css`, `workspace-design.css` et `mobile.css`. Aucun fichier Vite, package ou composant ancien n’a été modifié pour l’ajouter.

À partir du serveur Vite desktop déjà utilisé par les autres harness :

```text
/tests/international-company-harness.html?language=fr
/tests/international-company-harness.html?language=en
/tests/international-company-harness.html?language=de
/tests/international-company-harness.html?language=it
/tests/international-company-harness.html?language=en&initial=US
/tests/international-company-harness.html?language=fr&initial=CH
/tests/international-company-harness.html?language=en&initial=US&tax=configured
/tests/international-company-harness.html?language=fr&disabled=true
```

Sans `initial`, le pays reste vide. Le callback du harness garde seulement une valeur en mémoire. `window.__internationalCompanyHarness` expose `saveAttempts`, `saved`, `fail`, `hold` et `release()` pour les scénarios d’échec, réponse retenue et soumissions répétées. Un panneau de recette repliable expose aussi ces contrôles. Ils appartiennent au harness, pas au composant réutilisable ni à un parcours client publié.

La recette visuelle doit couvrir 390 px et desktop, les quatre langues, les trois étapes, CH/US, erreurs, lecture seule, attente et reprise après échec, clavier et agrandissement du texte. Vérifier notamment les cercles d’étape, les longues zones IANA, la visibilité du blocage US, l’absence de défilement horizontal et la conservation de la langue globale. Les captures et le verdict indépendant sont fournis par la mission principale ; leurs résultats ne doivent pas être déduits des seuls tests unitaires.

## Extension du système visuel existant

Mode **Operate**, pour un responsable de PME ou un administrateur qui choisit les paramètres d’une entreprise au bureau, sur ordinateur ou écran tactile. Le composant reprend les primitives `Field` et `Button` de `desktop/src/ui.tsx` et les propriétés CSS déjà utilisées par l’application. Il n’ajoute ni logo, ni police, ni marque, ni dépendance visuelle.

La source de vérité inspectée est `desktop/src/styles.css`, `desktop/src/workspace-design.css`, `desktop/src/ui.tsx`, `desktop/src/Onboarding.tsx` et `desktop/src/language.ts`. Les tokens utilisés sont notamment `--green-900` (#173d2c), `--green-700` (#34664d), `--green-100` (#e7efe9), `--ink`, `--muted`, `--paper`, `--line`, `--danger`, `--danger-soft`, `--radius-control` et `--radius-panel`. Le layer `workspace-design.css` garde ses surfaces blanches, son fond #f5f7f6 et ses contrôles. La typographie est héritée de la pile système Segoe UI de l’application. Les styles ajoutés sont tous limités au composant ; les champs/actions restent tactiles, les textes se répartissent sur plusieurs lignes et la grille passe à une colonne sous 600 px.

Le chargement Impeccable a retrouvé le contexte produit existant et un système visuel dans le code, sans `DESIGN.md` résolu au niveau desktop. Les anciens fichiers PRODUCT/DESIGN sont hors de la frontière de cette tâche et n’ont pas été réparés ou remplacés. L’ancien contexte limitant les travaux au design ne restreint pas la présente extension fonctionnelle explicitement autorisée. La documentation de surface est conservée ici, dans le fichier autorisé, et n’est jamais importée dans le bundle client.

### Direction contract — extension précise, sans nouvelle identité

**THESIS.** Trois décisions lisibles, puis une vérification, pour configurer une entreprise sans inventer sa juridiction ni activer sa facturation.

**OWN-WORLD.** Interface Zentra existante : pile système, vert sobre, champs et boutons natifs de l’application, surfaces blanches et bordures discrètes. Aucune direction esthétique nouvelle.

**STORY.** L’administrateur choisit le pays, remplit son adresse, choisit région et méthode comptable, vérifie et enregistre. Les blocages fiscaux restent visibles.

**FIRST VIEWPORT.** Titre et explication, trois étapes horizontales, choix de pays vide dans le formulaire. La suite est à droite dans le footer, puis pleine largeur sur mobile ; les champs nationaux apparaissent après un choix explicite.

**FORM.** Extension locale prescrite par la demande ; trois étapes fixées. Aucun concept-seed ni comparaison de nouvelles identités ne s’applique à ce périmètre précis.

**FINISH.** Revue indépendante sur captures réelles et verdict à leur portée, puis réconciliation documentaire avec l’incumbent conservé. Les tests unitaires et le détecteur ne remplacent pas cette revue ; aucun raster n’est ajouté.

## Preuves limitées à leur portée

`desktop/src/internationalCompanySetup.test.ts` vérifie le pays non présélectionné, la liaison d’organisation, les sélections existantes, la remise à zéro des valeurs nationales, les validations réelles du socle, les préférences littérales et les limites fiscales localisées. Les primitives visuelles sont remplacées uniquement pour ces tests de fonctions ; la validation métier importée est réelle. Les tests ne prétendent pas vérifier le DOM ou un service distant.

Commande ciblée : `pnpm --dir desktop exec vitest run src/internationalCompanySetup.test.ts`. Contrôle de types : `pnpm --dir desktop exec tsc --noEmit --pretty false`. Première exécution : 15 tests réussis et types desktop valides. Détecteur Impeccable exécuté une seule fois sur TSX/CSS : aucun problème mécanique. Les premières captures et corrections de focus/cercles relèvent de la QA de la mission principale ; leur confirmation finale et la revue indépendante restent distinctes de ces résultats.

Confirmation finale : huit inspections FR/EN/DE/IT à 390/1280 px et dix parcours (configuration US complète, validation, échec puis retry, absence de double submit, CH/US existants à 320 px). Aucune erreur JavaScript ou largeur de document excédentaire observée. Les corrections de focus, cercles d'étapes et statuts ont été revues indépendamment ; les 15 tests ont passé après la correction sémantique. Ces résultats restent ceux d'une fixture locale : `onSave` simulé, sans compte, persistance native ni service distant.
