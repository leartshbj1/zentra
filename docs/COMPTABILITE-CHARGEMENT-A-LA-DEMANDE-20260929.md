# Comptabilité — lectures à la demande, preuve locale du 29 septembre 2026

Lot local préparé après la source 1.90.9, depuis le checkout `a8661219`. **Non publié, sans modification des versions ni des artefacts 1.90.9.** Le périmètre produit est `desktop/src/AccountingScreen.tsx` ; présentation, textes financiers, calculs Rust et format des documents conservés.

## Problème reproduit et changement

La première vue Comptabilité demandait les cinq états, alors que la synthèse ne consomme que le compte de résultat. Le [témoin avant](../desktop/.qa/accounting-demand/before.json) utilise un vrai composant monté dans le navigateur et des réponses natives fictives : journal, balance des comptes, grand livre, bilan et résultat, chacun sur la même période.

Le chargement suit maintenant l'onglet actif :

| Vue | États demandés |
|---|---|
| Vue d'ensemble | Résultat |
| Journal | Journal |
| Grand livre | Grand livre du compte choisi ; aucune lecture sans compte |
| Balance des comptes | Balance des comptes |
| Bilan ou Résultat | Bilan + Résultat, nécessaires au contrôle commun d'export |
| Dossier de clôture | Balance des comptes + Bilan + Résultat |
| TVA, Plan & liaisons, Exercices, Immobilisations | Aucun de ces cinq états ; leurs composants gardent leurs lectures propres |

Une nouvelle visite relit les données locales : aucun cache de rapports ne peut survivre à une mutation. La sélection onglet/période/compte invalide immédiatement les réponses précédentes ; les valeurs de l'ancienne sélection sont retirées pendant le chargement. Les états réussis restent disponibles lors d'une erreur partielle, avec erreur et reprise explicites. Le dossier de clôture garde la propagation des échecs de son actualisation.

L'accès à une écriture précise réutilise le journal déjà contrôlé : une lecture sur la date, ou deux si le repli toutes dates est nécessaire. Il conserve l'identifiant exact, la vérification de présence et le focus. Le journal de TVA reste chargé sur toutes les dates. Une écriture en cours reste bloquante après un changement d'onglet ; son échec reste visible. Lever la garde après une extourne exige une lecture indépendante réussie du journal, même si une navigation invalide entre-temps le chargement de la vue. Ce chemin de reprise peut donc lire le journal deux fois si la rubrique Journal reste sélectionnée. Le partage d'un PDF participe au compteur d'actions bloquantes : ni sa fin ni celle d'une lecture plus récente ne débloquent l'autre opération.

## Résultats vérifiés

- **5 → 1 appels d'états à l'ouverture de la synthèse**, avec exactement `1 234.56 CHF`, `45.67 CHF` et `1 188.89 CHF` avant/après. Cela mesure le nombre de commandes, pas une accélération de 80 % ni la durée native.
- **40 tests unitaires ciblés réussis**, dont 13 nouveaux : matrice des onze onglets, arguments période/compte, conservation des objets/centimes/scopes, absence de compte, erreur partielle et nouvelle tentative. Les 27 autres couvrent preuves d'encaissement, clarté financière et idempotence des saisies manuelles.
- **18 étapes fonctionnelles par configuration, deux configurations réussies** : Edge 1440 clair/100 % et WebKit 390 sombre/200 %. Commandes par vue, changement de compte, filtres mois/trimestre/ouverts, scopes retournés, export annuel disponible, erreur visible/réessai, réponses tardives réussie et rejetée, focus journal avec/sans repli, et mutation fictive refusée après navigation. [Edge](../desktop/.qa/accounting-demand/after-edge-1440.json), [WebKit](../desktop/.qa/accounting-demand/after-webkit-390.json).
- La partie accès ciblé au journal et concurrence avec écriture monte `AccountingScreen` isolément dans la même fixture ; la coque de démonstration est masquée pendant cette partie pour éviter deux interfaces concurrentes. La saisie fictive ne fait aucune écriture réelle.
- **Trois défauts de concurrence reproduits avant correction**, sur les vrais composants : rejet du journal après navigation pendant la reprise d'extourne, fin du partage avant la lecture, puis ordre inverse. Le [témoin avant](../desktop/.qa/accounting-demand/concurrency-before.json) confirme la garde levée à tort et les deux déblocages prématurés.
- **Six cas de régression réussis après correction**, trois sous Edge et trois sous WebKit à 1440 px : garde conservée avec erreur visible, reprise réussie après lecture explicite du journal sans nouvelle extourne (une seule mutation fictive), et maintien de l'état occupé jusqu'à la fin des deux opérations pour chaque ordre. [Edge](../desktop/.qa/accounting-demand/concurrency-after-edge.json), [WebKit](../desktop/.qa/accounting-demand/concurrency-after-webkit.json). Le bouton de partage est rendu par un avertissement de livraison fictif ; aucun export ni partage système réel n'est exécuté. Les preuves et captures du parcours précédent sont conservées.
- Les **40 tests ciblés et TypeScript ont été relancés après ces corrections**. Vérification du diff réussie. Un seul [scan du détecteur](../desktop/.qa/accounting-demand/detector.json), vide ; il précède les derniers ajustements de gestion des erreurs et de concurrence, sans changement de présentation.

## Commandes reproductibles

Depuis `desktop`, avec Node et les dépendances existantes :

```powershell
node node_modules/vitest/vitest.mjs run src/accountingDemand.test.ts src/PaymentAccountingProofs.test.tsx src/financeClarity.test.ts src/accountingManualJournal.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5377 --strictPort
```

Dans un second terminal, définir `ZENTRA_PLAYWRIGHT_MODULE` vers le module Playwright installé si nécessaire, puis :

```powershell
node tests/accounting-demand-journey.mjs
$env:ZENTRA_QA_BROWSER='webkit'
$env:ZENTRA_QA_WIDTH='390'
node tests/accounting-demand-journey.mjs
```

L'option `--baseline` correspond au code antérieur et attend explicitement cinq lectures ; ne pas la relancer sur le code optimisé en écrasant le témoin.

Pour les régressions de concurrence, avec le même serveur déjà démarré (ne pas lancer une deuxième instance) :

```powershell
$env:ZENTRA_QA_BROWSER='edge'
node tests/accounting-demand-concurrency.mjs
$env:ZENTRA_QA_BROWSER='webkit'
node tests/accounting-demand-concurrency.mjs
```

L'option `--before` de ce second script exige les trois comportements défectueux antérieurs à leur correction. Elle a servi à enregistrer le témoin ; ne pas la lancer contre le code corrigé.

## Limites

Ces preuves utilisent les vrais composants et des réponses du bridge simulées. Elles ne mesurent pas SQLite, IPC, le binaire distribué, le serveur, ni la capacité multiappareil. Pas de build natif, CI, commit ou publication effectué pour ce lot.

Les captures [ordinateur](../desktop/.qa/accounting-demand/overview-edge-1440.png) et [téléphone](../desktop/.qa/accounting-demand/overview-webkit-390.png) ont été relues. À 390 px/200 %, le titre Comptabilité et la divulgation « Vos finances, en clair. » présentent des coupures excessives ; aucun CSS ni cette structure JSX n'a été modifié ici. Ce constat est transmis séparément, sans correction esthétique hors périmètre et sans verdict global d'accessibilité ou de présentation.
