# Zentra US — avoirs et encaissements PostgreSQL privés TEST V5

Suite validée le 10 octobre : `US-FINANCIAL-TEST-COMMERCIAL-V5-20261010.md` ajoute clients/devis/acceptation au même livre sous une capacité distincte. La factory settlement conserve son API et ses refus via des mécaniques partagées ; elle refuse une queue ERP avant replay. Les résultats ci-dessous décrivent le jalon settlement d'origine, sans les réécrire.

10 octobre 2026. Jalon local du même ERP international, après la fondation de promotion. Aucun contrat public ERP1–4, client CH, abonnement, route, interface ou installateur n'est activé ou modifié par cette phase. La migration reste locale TEST ; les protections communes de la fondation sont conservées.

## 1. Modifications

Le nouveau port `postgres-test-settlement-v5` raccorde le moteur financier existant à PostgreSQL pour deux opérations seulement : avoir client et encaissement ultérieur. Il conserve la baseline ERP4 et la provenance de promotion immuables. Un curseur séparé représente la révision et le hash du livre reconstruit ; il ne conserve pas une seconde comptabilité courante.

SQL reconstruit indépendamment chaque événement depuis la baseline réelle et son préfixe : facture émise, quantités déjà créditées, allocation cumulative avec arrondi, taxes historiques, encaissements et crédits distincts, montant restant, période ouverte, comptes et lignes exactes, révision du journal, acteur et reçu. Un journal équilibré fourni par l'appelant ne suffit pas. Les montants sont des chaînes d'entiers mineurs et `NUMERIC`/`BigInt`, sans conversion en flottants.

Les plans fiscaux TEST sont provisionnés par le propriétaire de la base dans un registre privé immuable ; un JSON ou hash de proof ne s'autorise pas lui-même. Une ligne historiquement taxée exige un plan d'ajustement même si son allocation partielle arrondit sa taxe à zéro. `adjustment_pending` ne signifie pas qu'un prestataire a effectué un reversal fiscal.

Le commit compare le préfixe canonique et la révision attendue, puis ajoute événement, reçu et curseur dans une transaction. Une reprise exacte retrouve le reçu avant le CAS ; une clé legacy ou de promotion reste réservée. Les anciens ports foundation refusent un livre ayant avancé, plutôt que de présenter sa promotion figée comme état courant. Les commandes ERP mixtes restent fermées sous cette nouvelle capacité.

## 2. Fichiers créés

- `lib/international/us-financial-test-settlement.ts` : adaptateur privé strict, autorité avant/après les attentes et validation de l'événement/reçu canonique.
- `lib/international/us-financial-test-settlement.test.ts` : tests du moteur réel avec transport RPC fictif, reprises, captures, révocation, horloge et corruption.
- `lib/international/us-financial-test-settlement.postgres.test.ts` : vraie chaîne SQL locale et données fictives, indépendante des réponses RPC simulées.
- `supabase/migrations/20261010083027_international_us_financial_test_settlement_v5.sql` : migration additive créée avec la CLI, sans modification des migrations historiques.
- Cette livraison et la preuve JSON de recette finale.

## 3. Fichiers modifiés

- `lib/international/us-financial-kernel-runtime.ts` : capacité privée settlement admise, avec refus des commandes ERP ; export du validateur strict du reçu. Le store mémoire TEST garde ses opérations mixtes existantes.
- `lib/international/us-financial-test-foundation.ts` : partage de la capture stricte du scope TEST, sans ouverture de son append.
- `lib/international/us-financial-kernel-types.ts` : commentaire de politique actualisé ; aucun type public modifié.
- `STATUS-20261009.md`, `US-FINANCIAL-PERSISTENCE-V5-20261010.md` et la livraison de fondation : état cumulatif et liens vers cette phase.

## 4. Migration et retour arrière

La migration ajoute `grant_version` aux événements privés encore vides, un curseur par livre et les plans fiscaux privés. Elle refuse son installation si la fondation contient déjà des événements : elle ne vide ni ne convertit silencieusement des données. Le premier append doit être dans une transaction distincte de la promotion, dont la contrainte différée de complétude reste en place.

RLS est activée ; PUBLIC, anon et authenticated n'ont pas accès aux nouveaux objets. Les fonctions restent `SECURITY INVOKER` avec search_path vide. Le rôle serveur est une autorité de confiance qui peut lire les tables/helpers privés ; cette phase ne prétend pas l'en isoler. Il ne peut pas provisionner lui-même les grants TEST ou les plans fiscaux. Aucun nouveau bypass GUC ou rôle SECURITY DEFINER n'est introduit.

Le grant versionné, le pays/configuration et la politique sont relus sous les verrous existants avant une nouvelle admission. La limite de timestamp acteur à l'horloge PostgreSQL + 30 secondes est une politique d'audit TEST, pas une règle fiscale ni une restriction sur la date comptable. Les acteurs historiques des lectures/reprises restent admissibles. Côté adaptateur, le callback d'autorité doit fournir une horloge de confiance monotone, au moins égale à l'acteur exécuté.

Retour arrière opérationnel proposé, non exécuté : révoquer les grants avec version supérieure, conserver promotion, événements, reçus, curseurs et plans ; ne jamais supprimer le marqueur pour rouvrir ERP4. Corriger par migration additive. Avant toute adoption hébergée, réconcilier les migrations/ACL réellement présentes, capturer les définitions remplacées et approuver le plan d'exploitation. Aucune migration hébergée ou activation production n'est exécutée.

## 5. Validation exécutée

Résultat final : **4 826 tests réussis dans 144 fichiers**, aucun échec, skip ou todo ; les 142 fichiers du jalon précédent sont conservés. Les **55 nouveaux tests adaptateur** et **30 nouveaux tests PostgreSQL** sont inclus dans ce total. Les tests adaptateur utilisent des réponses RPC fictives et le vrai moteur financier ; les tests PGlite exécutent les 26 migrations précédentes puis cette migration, avec émission réelle locale d'une facture fiscale TEST avant promotion. Aucun prestataire externe n'est appelé.

La matrice couvre notamment les tranches finales 35/37/35, reçu 50 + crédit 35 = dû 22, refus de paiement 23, tranche fiscale arrondie à zéro sur une ligne historiquement taxée, proof privée manquante, falsification des effets et reçus, anciennes clés réservées, CAS séquentiel, révocation/version du grant et acteur futur. Les inserts incomplets annulent la transaction. Après fermeture propre et réouverture du même répertoire NodeFS, le livre et les reçus exacts sont conservés ; le gel ERP4 reste actif.

TypeScript global sans cache incrémental, lint typé des six fichiers TS concernés avec warnings refusés, contrôle de marque et build production réussis. Le build précède uniquement les derniers commentaires de code et corrections de typage du test PostgreSQL ; aucune logique distribuée n'a changé ensuite. Les notices de compilation existantes ne constituent pas une publication.

Les erreurs intermédiaires ne sont pas masquées : un premier défaut de priorité d'opérateur empêchait l'installation SQL avant les tests ; un alias SQL ambigu faisait échouer un cas de taxe zéro ; le typage des nouveaux fixtures et unions d'événements a aussi été corrigé. La recette complète finale est verte sur les sources corrigées. La preuve `docs/evidence/us-financial-settlement-v5-20261010.json` conserve périmètre, résultats et empreintes.

Le lint Supabase CLI local n'est pas relancé : l'essai de la fondation a constaté l'absence de serveur sur 127.0.0.1:54322, inchangée ici. Les comportements/catalogues SQL sont testés dans PGlite ; cela ne remplace pas un lint ou une recette Supabase hébergée. Aucun db pull, advisor ou inventaire hébergé n'est substitué.

## 6. Risques et limites

- PGlite sérialise ses transactions. Reprise après fermeture propre, conflits CAS séquentiels et rollback ne prouvent ni concurrence multiconnexion, ni résistance au crash, ni absence de deadlocks, ni SLA.
- Le grant PostgreSQL TEST et la revalidation serveur ne sont pas une transaction distribuée D1/Auth/Stripe. Le protocole de révocation hébergé reste à établir.
- La fondation garde son refus administratif global de TRUNCATE sur les tables protégées, y compris CH/non promues ; sa contrainte d'exploitation reste à approuver avant adoption.
- Replay intégral et budgets JSON restent bornés. Aucun débit de 150 entreprises, journal illimité ou latence de production n'est démontré.
- Le registre de plans est une autorisation locale TEST, pas une observation de reversal fiscal auprès d'un fournisseur. Pas d'appel financier externe, taux américain inventé ou certification US GAAP.

## 7. Terminé dans ce jalon

Persistance commune baseline/avoirs/encaissements, reconstruction SQL indépendante, index de reçus et reprise exacte, soldes et journal cohérents, capacité séparée et autorité révocable. La capacité foundation demeure lecture/promotion uniquement ; ce nouveau port ne transforme pas l'ERP public en version 5.

## 8. Expérimental et suite obligatoire

Le cycle ERP mixte PostgreSQL, les sources/sidecars courants, projections publiques, navigateur TEST et transports natifs restent à raccorder au même livre. Puis restent notamment acomptes, récurrence, livraisons, crédits excédentaires/remboursements, cash basis, outbox fiscale et observations fournisseur, recette hébergée autorisée et validation professionnelle. L'objectif complet reste actif ; cette phase seule n'est pas un ERP US commercial terminé.
