# Zentra US — disponibilité TEST et garde-fous fiscaux

8 octobre 2026. Livraison incrémentale dans deux clones isolés. Le menu public Apple est déjà publié en version355, indépendamment de ce lot. Aucun déploiement US, migration hébergée, prix USD, abonnement suisse ou donnée client modifiés.

## Résultat

La disponibilité fiscale US devient une projection authentifiée, volatile et minimale. La session native utilise son coffre existant, le même espace et nonce ; aucun identifiant fiscal, preuve ou secret n'entre dans le DTO public. Le brouillon est conservé quand cette disponibilité expire, mais sa confirmation devient périmée. Une demande dont la réponse s'est perdue garde son enveloppe et sa clé exactes ; sa reprise historique reste possible même si le prestataire est indisponible. Le serveur refait ses contrôles financiers indépendamment de l'interface.

La passerelle Stripe22.6/API Dahlia vérifie un compte TEST dédié, les vrais réglages et toutes les registrations actives, puis les compare à une observation privée existante. Elle impose l'idempotence, une origine/configuration identique et des contrôles avant/après calcul. Ses82 tests SDK sont simulés : aucun appel fiscal Stripe réel n'a été exécuté. Aucune passerelle, aucun issuer ni evaluator n'est installé dans le runtime par ce lot ; `taxProvider:null` et les gates de production restent fermés.

Le contrôle SQL du plafond capturé précède toute reprise fiscale. Le journal schema4 est corrélé à sa source et à son fingerprint exact. Trois régressions ont ensuite montré qu'une facture historique schema1 ne pouvait plus être reprise après promotion du livre2/3/4. La correction consulte l'événement immuable correspondant au reçu original (qui n'a pas de schemaVersion), sans fallback ni en-tête inventé. Le livre courant exige toujours un lecteur adéquat ; le wrapper historique plafonné3 ne peut pas lire un livre4. La clôture d'une période est désormais une erreur contrôlée409, plutôt qu'un503 ambigu.

## Migration proposée et retour arrière

`supabase/migrations/20261008172520_international_us_tax_invoice_capability_v2.sql` ajoute le RPC fiscal9arguments et remplace additivement l'ancien8arguments par un wrapper plafonné3. Fonctions INVOKER, search_path vide, privilèges service-only et RLS conservés. L'historique SQL n'est pas réécrit. Seules des bases PGlite locales jetables ont reçu la chaîne.

Déploiement ultérieur : migration additive avant le port qui appelle le RPCv2, après validation explicite pour le staging/production. Retour arrière : fermer les gates US, conserver livres, événements, opérations et reçus ; ne pas rétrograder les livres ni effacer les écritures. Aucun rollback destructif exécuté.

## Contrôles réellement exécutés

| Périmètre | Résultat | Limite |
| --- | --- | --- |
| International web/domaines/HTTP/PG/D1/rapports |103 fichiers, 3918 tests passés,0 échec,8 skips | Huit wrappers navigateur opt-in ; Auth/Stripe fictifs ; PG sérialisée RAM |
| Auth et abonnements CH ciblés |6 fichiers,52/52 passés,0 skip | Tests locaux ; aucun paiement réel ni connexion client de production |
| Native frontend |21 fichiers,203/203 passés,0 skip | Core RAM réel ; ports Rust/readiness/provider simulés |
| TypeScript web/native, lint syntaxique, Vinext/Vite et diff check |Passés ; journaux et hashes versionnés | Lint typé bloqué par Windows avant analyse ; non annoncé réussi |
| Visuel natif |18 configurations initiales, puis3 confirmations séparées ; zéro overflow/page error |4 langues,clair/sombre,1440/390/320 ;200% texte racine, pas une certification zoom/accessibilité |
| Rust |9 nouveaux tests déclarés ;0 compilé,0 exécuté | Blocage précédent Windows conservé ; aucun contournement ni nouvel installateur |

Le sous-lot122 tests PG final et les82 tests de passerelle sont inclus dans le total international, jamais additionnés à celui-ci. Les premiers échecs, la passe intermédiaire et la correction de reprise historique sont conservés. Les trois confirmations visuelles finales n'ont pas repassé le scénario fonctionnel initial ; les203 tests frontend finaux le couvrent séparément.

## Compatibilité et sécurité

Les27 modules purs alignés web/native, le corpus financier historique, la CSS CH et les anciennes migrations restent identiques. Le checkout publié demeure propre au commit de version355. Cette preuve source ne certifie pas une session hébergée multi-appareils, la capacité sous charge, la restauration ou la RLS en production.

Une clé TEST temporaire a été affichée accidentellement lors de la création CLI d'une sandbox distincte, puis mise en quarantaine ; le journal local a été nettoyé et son utilisation arrêtée. Aucune clé de production ni opération fiscale réelle concernée. Sa révocation dans Stripe reste non confirmée : la quarantaine locale ne révoque pas une clé chez le prestataire. Une seconde création prudente a un résultat indéterminé, sans profil/JSON attendu observé ; elle n'a pas été répétée. Aucune clé ni lien de claim n'est versionné dans ces preuves.

## Terminé, expérimental et prochaines étapes

Terminés localement : normalisation des erreurs connues, clôtures/refus contrôlés, plafond fiscal avant commit/replay, compatibilité de reprises historiques, fingerprint schema4, readiness publique stricte, intégration des brouillons/reprises native et traductions des quatre langues. Le SDK gateway est codé et testé avec mocks.

Restent expérimentaux : émission fiscale TEST sans prestataire réellement observé, port Rust non compilé, et fonctionnement hébergé non validé. L'étape suivante exige la révocation de la clé exposée puis un nouvel accès TEST sûr, un compte/configuration et classifications réellement observés, puis devis accepté→facture+journal+PDF Letter dans le même livre de staging, sans fixture override. Les biens/exemptions/avoirs/remboursements, paiements/banking, tarifsUSD approuvés et workflows Support/Automation internationaux restent dans l'objectif complet.

Les sources primaires, hypothèses et validations professionnelles requises sont dans `US-REGULATORY-GATES-20261008.md`. Ce lot ne prétend ni certification USGAAP ni conformité fiscale exhaustive. Toute migration ou activation de production garde l'approbation explicite exigée par la mission initiale.

Le champ `publicContract` de la preuve native dédiée conserve explicitement l'instantané du contrat observé à 18:09:59 UTC, avant sa mise à jour par le lot parent. Son ancien hash n'est pas celui du contrat livré. L'inventaire final et `history.historicalNativePublicContract.currentSharedContract` identifient le contrat actuel ; la preuve native historique reste intacte.

Les inventaires et hashes sont dans `docs/evidence/us-tax-readiness-20261008.json` et la preuve native dédiée. Les logs bruts sont locaux sous `.qa/us-tax-provider/`, `.qa/us-tax-issuance/` et `desktop/.impeccable/review/native-us-tax-readiness/` ; aucun ancien writer journal/périodes n'a été relancé.

## Fichiers Web

Base : `47bd26388d15472742a4bf4b2a7ecb072ea933c6`.


### Créés

- `app/api/international/workspaces/[organizationId]/tax-readiness/route.ts`
- `docs/evidence/native-us-tax-readiness-20261008.json`
- `docs/evidence/us-tax-readiness-20261008.json`
- `docs/internationalization/NATIVE-US-TAX-READINESS-DELIVERY-20261008.md`
- `docs/internationalization/US-REGULATORY-GATES-20261008.md`
- `docs/internationalization/US-TAX-ISSUANCE-CONTRACT-20261008.md`
- `docs/internationalization/US-TAX-READINESS-DELIVERY-20261008.md`
- `lib/international/stripe-tax-test-gateway.test.ts`
- `lib/international/stripe-tax-test-gateway.ts`
- `lib/international/us-tax-readiness-server.test.ts`
- `lib/international/us-tax-readiness-server.ts`
- `lib/international/us-tax-readiness.test.ts`
- `lib/international/us-tax-readiness.ts`
- `supabase/migrations/20261008172520_international_us_tax_invoice_capability_v2.sql`


### Modifiés

- `lib/international/exports.postgres.test.ts`
- `lib/international/projects.postgres.test.ts`
- `lib/international/purchasing.postgres.test.ts`
- `lib/international/runtime-bindings.ts`
- `lib/international/us-device-server.test.ts`
- `lib/international/us-tax-invoice.postgres.test.ts`
- `lib/international/us-tax-invoice.test.ts`
- `lib/international/us-tax-invoice.ts`
- `lib/international/us-tax-operation-store.test.ts`
- `lib/international/us-tax-operation-store.ts`
- `lib/international/us-tax-operations.postgres.test.ts`
- `lib/international/workspace-creation.integration.test.ts`

## Fichiers Native

Base : `3e35b81ea17b33e46108c7b299a78b100118d4d5`.


### Créés

- `desktop/src-tauri/src/us_tax_readiness.rs`
- `desktop/src-tauri/src/us_tax_readiness_tests.rs`
- `desktop/src/NativeUsTaxIssuance.test.tsx`
- `desktop/src/NativeUsTaxReadinessStatus.tsx`
- `desktop/src/nativeUsTaxBoundary.test.ts`
- `desktop/src/nativeUsTaxReadiness.test.ts`
- `desktop/src/nativeUsTaxReadiness.ts`
- `desktop/src/translationsNativeUsTax.ts`
- `desktop/tests/native-us-tax-readiness-review.mjs`
- `docs/evidence/native-us-tax-readiness-20261008.json`
- `docs/evidence/us-tax-readiness-20261008.json`
- `docs/internationalization/NATIVE-US-TAX-READINESS-DELIVERY-20261008.md`
- `docs/internationalization/US-REGULATORY-GATES-20261008.md`
- `docs/internationalization/US-TAX-ISSUANCE-CONTRACT-20261008.md`
- `docs/internationalization/US-TAX-READINESS-DELIVERY-20261008.md`


### Modifiés

- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/us_admission.rs`
- `desktop/src/InternationalErpPilot.tsx`
- `desktop/src/NativeUsWorkspace.tsx`
- `desktop/src/internationalErp.ts`
- `desktop/src/nativeUsAccountingBoundary.test.ts`
- `desktop/src/nativeUsCopy.test.ts`
- `desktop/src/translationsNativeUs.ts`
- `desktop/tests/native-us-admission-preview.tsx`
