# Livre financier US V5 — plan journaux et périodes

10 octobre 2026. **Plan conservé ; lot implémenté et validé localement.** Voir `US-FINANCIAL-TEST-ACCOUNTING-V5-20261010.md` et sa preuve pour les résultats réels. Le texte ci-dessous conserve les décisions prises avant implémentation ; il n'annonce aucune fonction ni migration hébergée.

## 1. Modifications proposées

Continuer le même livre baseline immuable + événements V5 avec quatre commandes réellement présentes dans le domaine et le pont mémoire : `post_manual_journal`, `reverse_manual_journal`, `open_period`, `close_period`. Les six commandes ERP commerciales/achats et les avoirs/encaissements déjà livrés doivent continuer, sans deuxième état comptable modifiable.

La capacité privée proposée est `postgres-test-accounting-v5`, servie uniquement par une factory nommée et trois RPC de lecture/reçu/append. L'allowlist comporte exactement les dix commandes ERP cumulatives, `customer_credit` et `customer_payment`. Aucun nouveau compte, projet, facture client, prestataire fiscal, transfert bancaire, remboursement, cash basis ou mutation de configuration n'est admis implicitement. Elle reste US/USD/accrual/TEST, owner/admin/accountant sous grant vivant versionné. Les anciennes capacités doivent refuser toute queue qu'elles ne comprennent pas, avant replay.

### Révisions et périodes réelles

Le domaine de référence est `lib/international/accounting/us-journal.ts`, `accounting/ledger.ts`, `runtime.ts`, `runtime-sync.ts` et `us-financial-kernel-erp.ts`. La révision métier avance une fois par événement. La révision du vrai ledger est celle de son audit : une ouverture/clôture ajoute un audit sans écriture ; un journal/contrepassation ajoute un audit et une écriture. La révision compacte ERP4 éphémère retire seulement les audits/écritures des avoirs clients et renumérote les autres. Les périodes courantes doivent être reconstruites exactement, pas reprises éternellement de la baseline.

Un préfixe filtré comptant ses événements n'est plus un moteur de règlement suffisant. Créer une reconstruction de règlement explicitement alimentée par le vrai ledger courant : périodes ouvertes/fermées, révision, collisions des IDs/clés, comptes et cash. Réutiliser les helpers exacts d'arrondi, montants et preuves ; conserver les allocations cumulatives, reçus et événements historiques inchangés. Ne pas injecter des périodes nouvelles dans une baseline synthétique ni fabriquer des événements pour forcer un compteur.

### Journaux manuels et contrepassations

Chaque commande et chaque ligne a des champs exacts, des dates civiles valides, des textes bornés et des montants canoniques de 36 chiffres maximum par ligne. Débits = crédits, total non nul, comptes existants et classification explicite si mouvement net de cash. Ne pas imposer une nouvelle borne au total d'un journal si le domaine ne la possède pas. Les comptes de contrôle `receivables`, `payables`, `tax-payable` et `deposits` sont exclus du parcours manuel ; les sous-registres gardent leurs propres commandes.

La source d'un journal manuel est `manual_journal` avec sa référence déclarée. La contrepassation est uniquement celle d'un journal manuel existant non déjà contrepassé, avec lignes exactement inversées dans leur ordre et leur description, catégorie de trésorerie conservée, `manual_reversal` et `reversesEntryId` explicites. Aucun changement/suppression de l'original, ni contrepassation directe d'une facture, d'un paiement ou d'un autre registre. Une référence déclarée ne constitue pas une preuve d'archivage.

### Ouverture/clôture

Appliquer le domaine existant sans inventer de règle US : identifiant unique, dates réelles, fin >= début, au plus 100 périodes ; la nouvelle période commence après toutes les fins existantes. Clôturer une période existante ouverte seulement si aucune période antérieure ne reste ouverte. Une clôture déjà faite avec une nouvelle clé est un refus ; une reprise de la clé exacte retrouve son reçu. Le domaine n'autorise pas de réouverture d'une période clôturée. Ces opérations de contrôle ne garantissent pas une clôture fiscale complète ou certifiée.

Les écritures ultérieures utilisent les périodes reconstruites du préfixe. Une clôture ne doit pas invalider le replay d'une écriture historiquement admise avant elle ; une nouvelle écriture dans cette période doit être refusée. Une ouverture nouvelle doit permettre les achats, règlements, avoirs et journaux admissibles sur cette nouvelle période.

## 2. Fichiers à créer

- `lib/international/us-financial-test-accounting.ts` : factory nommée, sans profil arbitraire public.
- `lib/international/us-financial-test-accounting.test.ts` : vrai moteur, RPC fictives clairement distinguées.
- `lib/international/us-financial-test-accounting.postgres.test.ts` : vraie chaîne PostgreSQL locale, installation additive et reopen NodeFS.
- Une nouvelle migration versionnée créée avec le CLI Supabase, sans réécrire les migrations passées.
- Livraison à huit rubriques et manifeste de preuves après exécution.

## 3. Fichiers à modifier

- `us-financial-kernel-runtime.ts` et `us-financial-test-store.ts` : capacité/allowlist cumulatives exactes, profils privés constants, capture/revalidation inchangées.
- Les documents statut/persistance précédents, uniquement pour identifier le nouveau jalon réellement exécuté.

Aucune modification du domaine n'est prévue sans défaut concret démontré. Les interfaces publiques ERP1–4, les routes, l'UI, les binaires natifs, CH et les tarifs ne sont pas modifiés par ce lot backend privé.

## 4. Migration et retour arrière

Prévalider sous verrous tous les livres déjà admis, plans, curseurs et reçus avec le moteur précédent avant tout remplacement. Garder les mêmes tables et la même complétude atomique événement/reçu/curseur. Les INSERT directs et RPC d'append utilisent le même dispatcher et replay canonique. Conserver RLS, ACL, invoker, search_path vide, grants DB-owner-only, horloges, CAS et PO008 vivant exclusivement pour une nouvelle mutation de sa source. Les anciennes lectures/reçus/appends restent fermés aux nouvelles queues.

Rollback non exécuté : fermer les admissions par grants versionnés, conserver intégralement les événements et un lecteur compatible, réparer par migration additive. Ne jamais réouvrir ERP4 ou retirer la queue pour faire fonctionner un ancien client. Toute application hébergée exige l'approbation explicite déjà demandée par le projet.

## 5. Tests à exécuter

Parcours réel : avoir → fournisseur/facture/paiement partiel → journal → clôture → ouverture suivante → encaissement/avoir et reste de paiement fournisseur dans la nouvelle période → contrepassation du journal → modification commerciale. Comparer vraie projection, snapshots, révisions distinctes, sommes AR/AP/cash, reçus exacts et réouverture NodeFS. Installer la migration sur un livre purchasing déjà peuplé sans le réécrire.

Refuser journal déséquilibré, compte de contrôle/étranger/inconnu, montant ou texte non canonique, catégorie cash absente, mauvaise période, double contrepassation, source non manuelle, faux header/audit/posting/reçu, chronologie inversée, clé/ID en collision, grant révoqué ou changé, acteur/rôle/tenant substitué, tentative via anciens ports, write direct incomplet et modification d'historique. Tester les dates/révisions limites, le journal dont le total excède 36 chiffres mais pas ses lignes, les periods dans une baseline préexistante et les retries après réponse perdue.

Conserver les 148 fichiers de régression purchasing avant d'ajouter les deux nouveaux fichiers ; ne pas sommer des relances qui se recouvrent. Exécuter TypeScript global non incrémental, lint typé des sources modifiées, marque et build. PGlite sérialisé ne remplace pas une recette multiconnexion ou hébergée.

## 6. Risques

Le book et les snapshots répétés sont bornés, pas paginés pour une production de grande taille. Aucune preuve de 150 entreprises, SLA, crash recovery, atomicité D1/Auth/Stripe/PG ou conformité US GAAP n'est donnée. Les clôtures sont un contrôle applicatif limité, pas une déclaration fiscale. Le rôle serveur reste de confiance ; il ne doit pas provisionner ses propres grants/plans. Les sidecars et sources ERP4 restent gelés après promotion.

## 7. Terminé à cette rédaction

Uniquement l'analyse et le plan. Aucune ligne de code, migration nouvelle ou test exécuté n'est attribué à cette phase par ce document.

## 8. Suite et fonctions expérimentales

Après validation, raccorder la nouvelle émission client avec préparation fiscale V5 et source PO011. Construire ensuite un consommateur V5 utile : DTO bornés sans preuves privées, rapports/exports cohérents puis HTTP, synchronisation et interface pilote. Réutiliser ce même livre pour Support/Automation/originaux au lieu de multiplier les registres. La recette sandbox/staging, les effets prestataires et le pilote restent soumis aux validations requises. L'objectif ERP US complet reste actif.
