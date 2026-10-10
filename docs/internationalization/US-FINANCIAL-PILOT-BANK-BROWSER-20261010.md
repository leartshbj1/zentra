# Rapprochement bancaire V5 — protocole navigateur et export CSV, étape 2A

Livraison locale TEST du 10 octobre 2026, après le plan préalable `c7535d8`. Le protocole et les exports sont validés sur les sources définitives ; cette livraison ne comprend pas encore l’interface bancaire.

## 1. Résumé des modifications

L'étape 2A raccorde les factories HTTP bancaires existantes à sept routes et à la session financière commune. Elle ajoute des builders purs de review, la copie FR/DE/IT/EN, le transport d'une demande bancaire avec reprise exacte et un export CSV complet du relevé. Le domaine, les projections, les bindings, le store, les douze sources et la migration de l'étape 1 restent inchangés. Une revue bancaire n'ajoute aucun journal, paiement ou mouvement au livre financier.

Le lot comprend exactement **15 fichiers d'implémentation : 13 nouveaux et 2 modifiés**. Il constitue le jalon de protocole/transport/export du plan navigateur à 18 fichiers. Les trois fichiers d'interface prévus pour l'étape 2B restent à réaliser ; aucun panneau bancaire ni recette visuelle n'est livré par cette étape 2A.

La session garde en RAM la commande canonique, son corps JSON exact, son UUID et ses attentes F/B/R. Une réponse perdue ou un HTTP409/422 ne libère pas implicitement la demande. `retryBank()` renvoie le même corps ; un reçu historique ne devient jamais un head courant. Les mutations bancaires et financières partagent le verrou pending/writing existant. L'input impose une review possédée et courante, puis l'argument d'approbation explicite ; l'affichage de la case d'approbation appartient à l'interface suivante.

**Correction du cycle de vie validée :** une publication d’état peut appeler un abonné qui arrête la session de façon synchrone. Les gardes de génération/mutation sont renouvelées après les notifications avant de réadopter un snapshot, un head ou une activation. Les trois reproductions exactes passent dans le ciblage final et la régression. Les résultats antérieurs à cette correction restent archivés séparément.

Implémentation : `29de0581121eee458e264065f74b8918f6525bc8`. Preuve : [us-financial-pilot-bank-browser-20261010.json](../evidence/us-financial-pilot-bank-browser-20261010.json), SHA-256 `4c60db54a37d910bfbbc093e181b5fa49088f6ae7cf2456b013f5bfea70b397b`. Arbre de **3636 fichiers**, SHA-256 `cdb1041eb75e6f6316f694fb478d381504c0a53cc8fd097e110702a09c07e214`. Il s’agit des octets de travail figés, avant ces documents de livraison ; les sorties conservent le HEAD de plan et l’état staged utilisés pendant les commandes.

## 2. Fichiers créés

**Six sources nouvelles de protocole, copie et export :**

- `lib/international/browser-us-financial-pilot-bank-input.ts` — capture pure, reviews d'import et de commandes, preuves de pages, selector/constantes/headers d'export partagés.
- `lib/international/browser-us-financial-pilot-bank-copy.ts` — copie bancaire indépendante dans les quatre langues.
- `lib/international/browser-us-financial-pilot-bank.test.ts` — tests de l'input, du transport bancaire réel en mémoire et de la session commune.
- `lib/international/us-financial-pilot-bank-export.ts` — snapshot complet, validation whitelist, renderer CSV et handler protégé.
- `lib/international/us-financial-pilot-bank-export.test.ts` — parité avec les DTO existants, CSV complet, budgets, provenance et fences du handler.
- `lib/international/us-financial-pilot-csv.ts` — trois primitives CSV extraites à comportement identique.

**Sept nouvelles routes**, toutes sous `app/api/international/workspaces/[organizationId]/financial-pilot/bank/` :

| Fichier | Méthode HTTP | Délégation |
| --- | --- | --- |
| `head/route.ts` | GET | binding `HEAD`, head composite admis F/B |
| `context/route.ts` | GET | binding `CONTEXT` |
| `statements/route.ts` | GET | binding `STATEMENTS` |
| `statements/[statementId]/route.ts` | GET | binding `STATEMENT` |
| `statements/[statementId]/movements/route.ts` | GET | binding `MOVEMENTS` |
| `operations/route.ts` | POST | binding `POST` |
| `statements/[statementId]/export/route.ts` | GET | nouveau handler d'export complet, dépendances réelles du binding |

Le nom `HEAD` désigne le binding appelé par GET `/bank/head` ; aucune méthode HTTP HEAD supplémentaire n'est annoncée. Les routes restent minces, sans duplicata de l'admission ou de la logique métier. Le type de dépendances de l'export provient explicitement du serveur HTTP bancaire sous un alias distinct du type homonyme du domaine.

## 3. Fichiers modifiés

- `lib/international/browser-us-financial-pilot-session.ts` — façade bancaire, ownership des pages/reviews/exports, verrou partagé, reprise RAM, observation F/B, polling commun et purge du cycle de vie ; correction root supplémentaire décrite ci-dessus.
- `lib/international/us-financial-pilot-export-renderer.ts` — remplacement des trois fonctions locales par leurs imports sous les mêmes noms locaux ; aucune autre modification du renderer financier.

Le contrôle statique `csv-extraction-proof.json` compare exactement les trois corps de fonctions au commit du plan et le reste du renderer après normalisation CRLF/LF. Il ne constitue pas une comparaison d'octets CSV rendus avant/après. Les tests du renderer financier restent inclus dans le ciblage/la régression à consigner séparément. Aucun ancien contrat d'export financier, package, migration ou source de l'étape 1 n'est modifié par ce lot.

## 4. Migrations proposées et retour arrière

Aucune migration nouvelle dans l'étape 2A. La persistance cumulative V5 et le registre bancaire privé de l'étape 1 sont réutilisés ; aucune migration hébergée ou installation fournisseur n'est exécutée.

Le retour arrière fonctionnel ferme la gate bancaire TEST, qui reste fermée par défaut, et peut retirer ce raccordement de routes/session. Il ne supprime ni ne réécrit l'historique, les reçus ou les claims déjà conservés. L'arrêt/dispose de la session annule ses lectures et purge sa RAM et les ressources d'export. La perte de cette RAM ne prouve ni l'absence ni l'annulation d'un commit serveur.

## 5. Tests exécutés et résultats

| Contrôle sur sources définitives | Résultat réel |
| --- | --- |
| Régression finale | **6604/6604**, 203 fichiers ; zéro échec/pending/todo ; les 201 fichiers précédents conservés. |
| Ciblage navigateur/export commun | **571/571**, 16 fichiers ; zéro échec/pending/todo. |
| Nouveaux tests navigateur/input | **47/47**, y compris les trois réentrances stop. Inclus dans les résultats ci-dessus. |
| Nouveaux tests export | **59/59**, inclus dans les résultats ci-dessus. |
| TypeScript global | Sortie 0, tsc sans incremental. |
| Lint typé | Sortie 0, les 15 fichiers TS de cette tranche, deny-warnings. |
| Marque et build production | Sorties 0/0. Un build réussi ne vaut pas déploiement. |
| Index et whitespace | Exactement 15 fichiers d’implémentation, sortie 0. |
| Revue indépendante | accepted-static-protocol ; aucun défaut bloquant restant dans le périmètre relu. |
| UI/navigation/captures bancaires | Non exécutées : étape 2B non implémentée. |

Les ciblages recoupent la régression : **ne pas additionner leurs totaux**. Les six commandes finales partagent le même arbre SHA et les mêmes 15 empreintes avant/après. La régression a duré 782.3 secondes. Les anciennes tentatives, leurs corrections de fixtures et les passes précédant la correction lifecycle sont conservées avec leurs propres sources ; elles ne remplacent pas le résultat final.

Les tests reproduisent import→match→complete sans changement du livre financier, reprise du même corps/UUID/F/B/R après réponse perdue ou409/422 tardif, conflit CAS sans reçu conservé, B seul sans reload du snapshot financier, F seul, heads hors ordre, repli financier unique, verrou commun, pages/reviews possédées, purge et les sept routes réelles. L’export couvre plus de25lignes/mouvements, 41groupes, legacy, sommes signées/net0, contrepassation, provenance, scopes/révisions modifiés, données mutables/getters, attentes réussies/rejetées, UTF8/formules Unicode et délais. La garde de sortie12MiB est éprouvée par un rendu injecté ; un autre cas construit un livre et un registre valides atteignant le budget privé du snapshot. Ces garanties restent distinctes.

La régression conserve les recettes PostgreSQL précédentes et leurs34migrations, exécutées dans PGlite sérialisé avec Auth/D1 synthétiques. Les deux anciens alias de recette réécrits par les tests sont archivés pour cette nouvelle exécution puis restaurés exactement ; les douze sources et la preuve Stage1 sont inchangées. Il ne s’agit pas d’une preuve PostgreSQL multiconnexion ou hébergée. Les tests navigateur utilisent les vrais handlers et le kernel mémoire V5 fictif ; aucune interface bancaire ni seconde session bancaire réelle n’est validée ici.

Le contrôle d’extraction CSV prouve l’identité des trois corps de fonctions et du reste du renderer sous normalisation EOL. Les suites réelles du renderer financier passent dans le ciblage et la régression ; aucune comparaison de fichiers CSV avant/après n’est revendiquée. La revue indépendante est statique et n’a exécuté aucun test.

La première régression complète a échoué : 6603/6604, avec un seul cas PostgreSQL existant dépassant sa limite explicite de 60 secondes. Cette sortie est archivée et n’est pas présentée comme une réussite. Les 12 tests bancaires PostgreSQL ont ensuite passé seuls, puis la régression complète a été relancée seule, sans compilation ou autre commande de test concurrente. Aucun test ni délai n’a été modifié. Ces résultats montrent la sensibilité de cette recette au temps disponible sur la machine ; ils ne prouvent pas à eux seuls l’absence de défaut de concurrence.

## 6. Risques identifiés

Le rapprochement et ce transport restent **privés locaux TEST, US/USD/accrual**. Les lectures/proofs reposent sur l'admission existante Auth/D1, les droits, la gate, le grant, l'opt-in et la policy. Les tests synthétiques ne démontrent pas leur exploitation hébergée, une transaction distribuée Auth/D1/PostgreSQL, la charge ou un SLA. Une réponse après commit peut rester incertaine ; seule une reprise exacte peut retrouver son reçu. Un vrai conflit CAS sans reçu peut nécessiter le rechargement explicite de l'espace et une nouvelle lecture de l'historique.

Les demandes, reviews et exports sont détenus uniquement en RAM ; ni localStorage, ni IndexedDB, ni URL n'archivent l'intent ou le CSV. Stop/dispose/denial/logout purgent les ressources possédées, et les gardes empêchent leur restauration par réponse tardive. La façade ne peut pas promettre la purge d'un brouillon React encore inexistant ; son raccordement sera vérifié avec l'interface. L'original CSV n'est pas archivé et sa provenance manuelle ne prouve pas l'authenticité du relevé.

Les limites effectives restent cumulatives : fichier CSV importé 524 288 octets, corps de requête 1 048 576 octets, réponses bancaires JSON 2 621 440 octets et budgets privés de snapshot (50 000 nœuds, profondeur20, texte total 2 097 152 caractères, chaîne 524 288 caractères, tableau 1 000 éléments) ; au plus 40 pages de preuves par côté et 1 000 sélections uniques par côté. Les limites persistantes de l'étape 1 demeurent 100 relevés, 1 000 lignes par relevé et 1 000 opérations par entreprise, sous le budget du registre complet. La pagination n'ajoute pas de capacité.

L'export limite réellement ses octets UTF8 à 12MiB, sans troncature, avec un délai total de 30 secondes couvrant son transport/rendu/hash. Les budgets privés du livre, du registre et du snapshot peuvent refuser avant cette taille. Un timeout/abort ferme la divulgation ; il ne préempte pas du CPU synchrone ou une RPC non annulable. Les fonds, flux bancaires réels, frais manquants, échéanciers de chèques/dépôts en transit et fiscalité restent hors de ce rapprochement exact.

## 7. Fonctionnalités terminées

Au périmètre local TEST validé de l'étape 2A : sept routes minces ; input pur et copie en quatre langues ; façade bancaire dans la session commune ; reviews et pages possédées ; approbation explicite au protocole ; verrou pending/writing entre tous les modules ; reprise du corps initial sans rebase ; export complet et download d'un résultat courant possédé.

La session utilise un seul timer à cadence de 3 secondes quand la page est visible et en ligne. Banque active ou pending bancaire : un seul GET du head composite F/B par tick, puis snapshot financier uniquement si F change et qu'aucun pending/writing ne l'interdit. B seul invalide la banque et préserve le snapshot financier de même F. Les planchers F/B refusent les retours périmés sans fabriquer une paire par maxima. En cas d'échec bancaire hors denial, un seul GET `/head` financier de repli peut préserver les autres modules ; la banque garde son erreur et sa dette de fraîcheur, et le pending reste inchangé. Sur401/402/403, purge commune, sans repli. Aucun fallback ERP4.

Le CSV contient toutes les lignes, groupes, relations match→ligne et match→journal séparées, mouvements et évaluation courants, ainsi que la completion enregistrée. Il distingue F financier, B bancaire, R du relevé et le vrai L ledger. Legacy reste recorded-only : mouvements, évaluation et source historique null, sans différences V5 inventées. BOM UTF8, CRLF, quoting, ISO, montants USD BigInt exacts, labels traduits et neutralisation de formules après préfixes Unicode sont partagés avec les primitives financières inchangées.

Le handler valide sa lecture atomique initiale `{book,register}`, construit le snapshot complet, renouvelle l'admission après les attentes réussies et rejetées, capture ses octets avant hash, puis relit atomiquement la cible pour corroborer F/B/R/origin/id et son contenu canonique. Le head composite et l'admission finale précèdent l'attachment. La session corrobore à son tour identité, selector, hashes, longueur, media, UTF8/BOM, filename et headers de sécurité, puis invalide le résultat au changement de paire/mutation et révoque les URL possédées. Aucune complétude ne repose sur la seule page affichée ni sur le seul head pour R.

## 8. Fonctionnalités expérimentales et prochaine phase

L'étape 2B doit ajouter seulement les trois fichiers d'interface prévus : `components/account/us-financial-pilot-bank.tsx`, `components/account/us-financial-pilot-bank.css`, puis le raccordement dans `components/account/us-financial-pilot.tsx`. Elle devra présenter l'import explicite, les sélections hors page, les totaux et la case d'approbation humaine, la reprise incertaine, le rechargement avec perte RAM annoncée, la completion historique distincte du courant, le blocker legacy et l'export complet. Elle réutilisera la session commune ; aucun second store/timer navigateur n'est prévu. Inspection desktop/mobile clair/sombre et traduction visible restent à effectuer à ce stade.

Le pilote US global demeure en développement : ni produit US complet, ni conformité fiscale/US GAAP, ni banque/provider réel, ni déploiement production, ni migration hébergée, ni application native ne sont revendiqués. Admission/provisioning hébergés, prestataire fiscal réel, cash basis, clôture annuelle complète, originaux/Support/Automation, devises étrangères, commandes/projets avancés, charge et distribution native restent ouverts. Les clients, données, abonnements et règles suisses restent préservés ; aucun changement Stripe n'appartient à cette livraison. L'objectif international demeure actif.
