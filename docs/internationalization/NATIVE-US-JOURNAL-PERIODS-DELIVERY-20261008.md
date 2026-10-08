# Native US — journal et périodes, 8 octobre 2026

## Périmètre livré

Clone autorisé : `international-native-admission`, base `59d1c771a00b1c8502ab270c187222d42e390c11`. Aucun déploiement, abonnement, fournisseur fiscal ou donnée réelle n'a été modifié.

L'écran Comptabilité US rassemble les rapports existants, le journal et les périodes du **même livre ERP admis**. Il permet aux rôles owner/admin/accountant de préparer une écriture manuelle équilibrée, de la relire, de la confirmer, de contrepasser une écriture manuelle et d'ouvrir/clôturer les périodes. Les autres membres conservent la consultation. L'activation du schéma 4 à partir du schéma 3 exige le propriétaire et une confirmation ; les livres 1/2 ne sont pas promus artificiellement.

Les brouillons restent présents lorsqu'une autre opération change la révision globale. La confirmation devient invalide et la prochaine vérification relit les périodes/comptes/écritures actuels. Une réponse perdue après engagement conserve la clé et l'enveloppe exactes ; la reprise ne crée pas une deuxième écriture. Un changement d'acteur, de rôle ou de nonce purge les données de l'ancienne admission.

Les montants USD sont des chaînes d'unités mineures exactes, avec calcul BigInt. Les comptes clients, fournisseurs, taxe à payer et acomptes sont exclus des écritures manuelles. Une contrepassation conserve l'original et utilise ses lignes inversées, sans modifier les documents ni les paiements.

## Alignement et frontière native

La closure pure comprend 27 modules, dont `accounting/us-journal.ts`, alignés sur HEAD web `90d131646a352e149c03b80b9260ec8eda724a2d` et le gel autorisé publié dans `docs/evidence/us-journal-domain-source-freeze-20261008.json` des deux repositories. Cette copie conserve exactement les 4029 bytes et les 16 hashes historiques du gel initial, SHA256 `cc1098be27bd9746def03a412c05f20b2c2b8b3cf6a6fdd890b76b2770348b85`. Son attribut Git `-text` préserve ses CRLF bruts après checkout. Le script vérifie les SHA256 de provenance, normalise explicitement les modules UTF-8/LF et conserve les preuves dans `NATIVE-SHARED-DOMAIN-MANIFEST-20261008.json`. Aucun binding serveur, secret ou stockage financier parallèle n'est copié.

Le gel historique inclut 15 fichiers de domaine/tests et le contrat documentaire tel qu'il était au gel. Les 15 sources correspondent encore aux hashes bruts ; le contrat web a ensuite été complété. Ce relevé historique n'est pas réécrit pour présenter la version documentaire ultérieure comme celle qui a été gelée.

Le nouveau pairing US annonce explicitement la capacité 4. Une ancienne autorisation de capacité 3 reste immuable, y compris après `/me`, reprise d'une réponse perdue ou export. Les wrappers Rust historiques restent bornés à 3 ; seuls les ports US liés au coffre utilisent les variants qui reçoivent la capacité effectivement capturée. L'interface explique le refus si le nouveau pairing est fermé. Le code ne déclare pas un ancien credential compatible 4 et ne transforme pas un livre par un simple header.

La structure native publique et l'origine scope/nonce demeurent les seules entrées de confiance. Le schéma 4 utilise les mêmes commandes ERP et le même CAS/delta que les autres clients. Le Rust fait les contrôles de forme/origine/rôle avant et après les échanges ; les règles comptables financières restent dans l'autorité ERP partagée.

## Fichiers créés

- `desktop/src/NativeUsAccounting.tsx`
- `desktop/src/nativeUsAccountingForms.ts`
- `desktop/src/translationsNativeUsAccounting.ts`
- `desktop/src/NativeUsAccounting.test.tsx`
- `desktop/src/nativeUsAccountingForms.test.ts`
- `desktop/src/nativeUsAccountingSession.test.ts`
- `desktop/src/nativeUsAccountingBoundary.test.ts`
- `desktop/tests/native-us-accounting-review.mjs`
- `lib/international/accounting/us-journal.ts` — copie pure autorisée.
- Le présent rapport de livraison.
- `docs/evidence/us-journal-domain-source-freeze-20261008.json` — copie exacte du gel autorisé, également publiée dans le repo web.

## Fichiers modifiés

- Shell, transport et copies US : `InternationalErpPilot.tsx`, `NativeAdmissionRoot.tsx`, `internationalErp.ts`, `nativeAdmission.ts`, `translationsNativeUs.ts`.
- Tests frontend : `InternationalErpPilot.test.tsx`, `nativeAdmission.test.ts`, `nativeSharedDomain.test.ts`, `nativeUsCopy.test.ts`.
- QA fictive : `native-us-fixture.ts`, `native-us-admission-preview.tsx`, `generate-native-us-corpus.test.ts`.
- Source des ports US et gardes de protocole : `international_erp.rs`, `us_admission.rs`, `us_admission_tests.rs`, `us_exports.rs`, `us_exports_tests.rs`.
- Provenance : script d'alignement, `.gitattributes`, manifeste de closure et corpus JSON/manifeste Rust.
- Closure pure : `erp-request.ts`, `erp-schema-capability.ts`, `runtime-sync.ts`, `runtime-types.ts`, `runtime-validation.ts`, `runtime.ts` et `accounting/ledger.ts` (élargissement de type audit uniquement).

Aucune migration native. Les migrations web/PG/D1 sont livrées par le lot serveur séparé. Aucun fichier SQLite métier CH, aucune licence CHF, aucun composant App CH et aucune CSS CH n'a été modifié. Les tests de frontière comparent explicitement ces fichiers à HEAD.

## Vérifications réellement exécutées

Preuves durables locales sous `desktop/.impeccable/review/native-us-accounting/` (ignorées par Git, données fictives uniquement).

| Vérification | Résultat | Preuve |
| --- | --- | --- |
| Frontend/transport/domaine admis ciblés, avant la publication de provenance | 18 fichiers, **146/146 tests**, aucun skip | `native-regression-final.json` et `.log` |
| Contrôle complémentaire après versionnage du gel | 3 fichiers, **13/13 tests**, aucun skip ; SHA de la copie, attribut Git, alignement 27 modules, schémas 1–4, régénération corpus et frontière CH | `provenance-regression-final.json` et `.log` |
| TypeScript | exit 0 | `typecheck-final.log` |
| Lint syntaxique | 21 fichiers, 191 règles, 0 diagnostic | `lint-syntax-final.json` |
| Lint typé du projet | **non exécuté complètement** : Windows refuse le lancement de `tsgolint.exe`, erreur `UNKNOWN` | `lint-type-aware-attempt.log` |
| Build Vite uniquement | exit 0 ; avertissement de chunks existants >500 kB | `build-vite-final.log` |
| Rustfmt des cinq fichiers Rust modifiés | exit 0, source uniquement | `rustfmt-source-final.log` |
| Git diff check | exit 0 | `diff-check-final.log` |
| Génération du corpus réel RAM | 38 vecteurs, schémas 1–4 | corpus et manifeste sous `desktop/src-tauri/tests/fixtures/` |
| UI locale | 18 configurations, 0 débordement et 0 erreur de page | `browser-final-evidence.json` + 18 PNG |
| Parcours navigateur fonctionnel | confirmation/édition, engagement avec réponse perdue + reprise exacte, contrepassation, période future, clôture chronologique, purge acteur/lecture seule | `browser-results.json`, `browser-functional.log` |

Le corpus est produit par le vrai `executeErp`/`applyErpDelta` avec autorité RAM fictive : SHA256 `04a0c4892e5c153e4bd43b60d1d277477d1f258b4d7d28749f6a9bd141e4e564`, inchangé après régénération. Seuls la référence du script, son assertion de provenance, les attributs ciblés et les manifestes ont changé après les 146 tests produit. Les 13 contrôles complémentaires sont une preuve séparée, pas un total de 159 tests distincts. Les gardes TS valident aussi les schémas historiques, les révisions/deltas, l'intégrité de provenance et le choix explicite de capacité.

La CSS `desktop/src/dark.generated.css` reste exactement préservée avant et après Vite : SHA256 `424c7ee66d05af6c43ecd169f3ea2bdd4d0b8e9250a83462b73f330ebd41197f`. Aucun générateur CSS CH n'a été lancé.

## Revue visuelle bornée

Un seul lot : français, allemand, italien et anglais ; clair/sombre ; 1440 px et 390 px, puis 320 px avec texte 200 % en DE clair et EN sombre. Les 18 images ont été ouvertes et observées. Police système incumbent, composants et couleurs existants conservés. Aucun nouveau cycle de refonte ni correction visuelle supplémentaire n'a été nécessaire.

Le premier lot avait déjà terminé les 18 captures et leurs assertions avec zéro défaut visuel. Son parcours fonctionnel a ensuite rencontré un sélecteur de test devenu périmé après la reprise confirmée (le sous-menu revient sur Rapports après remontage). Le scénario a été corrigé pour sélectionner Journal de nouveau, puis **le parcours fonctionnel seul** a repassé. Le fichier initial et son message sont conservés dans `browser-visual-initial.json` ; aucune réussite intégrale rétroactive n'est attribuée à ce premier lancement.

La revue indépendante utilise les agents existants faute de slot/thread disponible pour un reviewer neuf ; cette substitution est déclarée. Les captures sont une preuve locale du shell navigateur, pas d'un iPhone physique ou d'un binaire Rust livré.

## Limites restantes

- Aucun Cargo ni test Rust compilé n'a été exécuté : les tests de protocole Rust sont écrits et les sources formatées, mais nécessitent une validation native autorisée dans un environnement capable de lancer la chaîne.
- Pas de parcours hébergé réel, de multi-appareils réel, de mesure de charge, de fichier/dialogue natif ni de distribution Windows/macOS/iOS/Android dans ce lot.
- Le pairing 4 et les mutations restent dépendants des gates serveur, fermés par défaut. La QA autorise explicitement un fixture de capacité 4 ; elle n'accorde pas de droit production.
- Émission fiscale de factures en production toujours fermée sans fournisseur de calcul fiscal digne de confiance. Aucun taux nul, grant ou certification US GAAP n'est inventé.
- La comptabilité reste le pilote US. Les règles complexes doivent être validées par un professionnel avant activation production.
