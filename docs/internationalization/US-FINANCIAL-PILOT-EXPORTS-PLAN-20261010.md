# Prochaine tranche — exports du pilote financier V5, DTO1

10 octobre 2026. Plan de préparation en lecture seule. Aucun code métier, route,
test, build, migration, réglage ou donnée de production modifié par cette étude.
Les tests ci-dessous sont des critères à exécuter lors du développement, pas des
succès annoncés. Plan enregistré avant développement dans `docs/internationalization/`.

## Résultat minimal utilisable

Dans le pilote financier privé TEST, télécharger la facture sélectionnée en PDF
et les rapports affichés en PDF ou CSV. Les exports utilisent le livre V5 validé
et sa révision exacte. Ils distinguent toujours `total`, `received`, `credited`
et `outstanding` ; un avoir n'est jamais présenté comme un encaissement.

Premier périmètre : facture, balance, résultat, bilan, trésorerie lorsque
disponible, grand livre d'un compte et état des créances **courantes**. Aucun
export de restauration, aucune archive légale, émission, modification, envoi
e-mail, écriture comptable, reçu supplémentaire ou appel fournisseur fiscal.
Une facture PDF est une représentation du document émis existant, pas une
nouvelle émission ni une preuve de paiement ou de conformité fiscale réelle.

## Points vérifiés dans les sources

| Source actuelle | Conséquence pour ce lot |
| --- | --- |
| `lib/international/export-snapshot.ts:160–204` | `buildUsExportSnapshot` valide un `ErpState` 1–4, utilise `invoiceBalance` et la sémantique documentaire ancienne. La ligne193 déduit aussi « reçu » de total moins restant. Ne pas lui fournir une fausse projection ERP4 du livre V5. |
| `lib/international/export-renderer.ts:23,38,64` | Les renderers HTML/CSV/PDF appellent eux-mêmes `validateUsExportSnapshot`. Leurs fonctions exportées ne constituent donc pas des renderers génériques compatibles V5. |
| `lib/international/export-server.ts:129–211` | Modèle utile de contrôle d'accès, attente de fontes/rendu/hash puis contrôle final, limites et headers de téléchargement. Ses dépendances, selector, `ErpSchemaVersion` et headers `Erp-Revision` restent ceux d'ERP1–4. |
| `lib/international/browser-export-session.ts:38–102` | Modèle de fetch cookie-only, annulation, hash, MIME, nom de fichier, résultats possédés par l'instance et révocation des URL Blob. Son contrat/runtime/route ne doivent pas être branchés tels quels au pilote. |
| `lib/international/us-financial-pilot-projection.ts:19–42,87+` | Rejoue le livre courant unique, impose la révision, calcule les quatre montants depuis `view.settlements` et whiteliste la facture/ses parties. Détail des paiements/avoirs paginé à25. |
| `lib/international/us-financial-pilot-reports.ts:22+` | Rapports issus du vrai `view.ledger` ; périodes, vrais journaux, achats, crédits et contrepassations conservés. AR explicitement courant ; GL paginé à25 et lié à compte/période/révision. |
| `lib/international/us-financial-pilot-server.ts:57+` | Protocole navigateur séparé ; admission Auth/D1, rôle financier, grant/opt-in PG privé, revalidation après les dernières attentes et refus des credentials natifs. |
| `lib/international/us-financial-pilot-bindings.ts:17–49` | Flags TEST fermés par défaut, identité `getZentraUser({offerAccess:false})` sans renouvellement de session implicite, `requireUsWorkspaceAccess` effectif, rôles owner/admin/accountant. |
| `lib/international/us-financial-pilot-store.ts:78+,109+` | Scope privé versionné ; wrappers PG d'opt-in/grant atomiques **dans PG**, pas transaction Auth/D1/PG. `head` léger ; lecture du livre validé disponible sans nouvelle persistance. |

### Fontes et bibliothèques

Réutiliser `getUsExportFonts()` dans `export-fonts.ts`. Il décode les buffers
embarqués et remet des copies possédées à chaque rendu, sans filesystem ni
réseau à l'exécution. Noto Sans Regular/Bold, SIL OFL1.1, provenance épinglée à
`ffebf8c1ee449e544955a7e813c54f9b73848eac` dans
`public/fonts/us-exports/provenance.json` ; conserver `OFL.txt` et les empreintes.
Packages déjà présents : `pdf-lib`1.17.1 et `@pdf-lib/fontkit`1.1.1. Aucun ajout
de fournisseur, police distante ou dépendance nécessaire.

Réutilisables : US Letter612×792, mesure/glyphes avec la vraie fonte, fragmentation
de longues lignes, répétition des en-têtes, pieds de page, exacts minor units,
échappement et protection CSV. Copier/extraire seulement ces primitives sous
un contrat de présentation neutre ; ne pas importer l'ancien builder/validateur
pour contourner son incompatibilité. Pour limiter les régressions CH/ERP1–4,
commencer avec un renderer pilote séparé et les mêmes fontes.

## Contrat public fermé proposé

Nouveau `UsFinancialPilotExportSnapshot`, `consumer:'financial-pilot'`,
`schemaVersion:1`, organisation, révision financière, vraie `ledgerRevision`,
langue FR/DE/IT/EN, devise USD, papier Letter et selector d'export validé.
Aucun header/protocole public ERP5. Selector obligatoire avec `revision`, type
facture+id ou rapport+paramètres ; formats initiaux `pdf|csv` seulement.

Le snapshot whiteliste des parties imprimables, lignes, dates, montants et
sections propres à chaque document. Le modèle facture conserve l'identité et
l'adresse du vendeur **figées à l'émission**, le client et les lignes émises.
Il montre le total original, puis les trois sommes reçu/crédité/restant à la
révision exportée. Paiements et avoirs sont des historiques séparés lorsqu'ils
sont inclus, avec leurs vraies dates et la mention TEST d'ajustement fiscal en
attente. Ne pas fabriquer de `invoice.recordRevision` qui n'existe pas.

Rapports : identité d'organisation et en-tête daté explicitement. Attention :
`CompanyConfiguration` ne contient pas de nom commercial, et `Reports` DTO1
ne contient ni vendeur ni adresse. Ne pas prendre arbitrairement le vendeur de
la dernière facture, ni accepter un nom transmis par le navigateur. Version
minimale honnête : organisation+adresse whitelistée depuis la configuration du
livre. Si le nom est requis, créer un port serveur de métadonnées actuel admis
et corroboré, distinct de l'autorité membership ; ne pas rouvrir un ancien
reader vendeur gelé après promotion.

Ne jamais transmettre baseline, policy, promotion, événements/commits, EIN,
preuve/calculation/provider references, contexte marchand, grant/opt-in version,
clés d'idempotence ou empreinte privée du livre. Un SHA256 des **octets publics
d'export** et du selector public est acceptable et n'est pas l'empreinte privée.

## Complétude et calculs

Ne pas rendre la première page25 comme un export complet. Le builder lit une
fois le livre validé exact et construit toutes les lignes publiques nécessaires
depuis cette même vue privée, dans les budgets. Il ne dépend pas de la boucle
de pagination UI, de plusieurs snapshots HTTP ni d'un état React.

Pour les rapports, réutiliser `accounting/reports.ts` sur le vrai `view.ledger`
et `financialPilotPublicSource` pour les références autorisées. Ne pas filtrer
les crédits avant calcul ; ne pas remplacer les périodes actuelles par celles
de la baseline, ni confondre révision globale et révision de journal/audit.
GL complet : solde d'ouverture, mouvements triés, soldes courants et clôture
réconciliés ; aucun solde d'ouverture de page pris pour celui du rapport complet.
Les créances restent intitulées « courantes à la révision exportée », jamais
« au asOf » sans reconstruction historique dédiée. Trésorerie indisponible si
classification manquante : rendre explicitement cette indisponibilité ou
refuser l'export concerné ; ne pas produire de zéros inventés.

Budgets initiaux proposés, à confirmer dans les tests :1000 lignes,500000
caractères,200 pages PDF,12MiB de sortie. Rejet explicite413 avant publication,
aucune troncature silencieuse. Tous les montants utilisent BigInt/chaînes
minoritaires ; CSV décimaux exacts non groupés, textes protégés contre formules,
guillemets/CRLF/BOM traités et dates civiles américaines indépendantes de la langue.

## Admission et transport

Routes proposées :

- `GET /api/international/workspaces/{org}/financial-pilot/exports/invoices/{id}?revision=N&format=pdf&language=fr`
- `GET /api/international/workspaces/{org}/financial-pilot/exports/reports/{kind}?revision=N&format=pdf|csv&language=fr&from=...&to=...&asOf=...&accountId=...`

Chaque route utilise le header `X-Zentra-Financial-Pilot:1`,
`X-Zentra-Expected-User`, cookies same-origin, no-store et refus d'Authorization.
Allowlist fermée de types et paramètres, doublons et champs superflus refusés.
Identité Auth actuelle, accès D1 effectif, rôle owner/admin/accountant, Gestion
actif, configuration US/USD/accrual, flags TEST et scope PG opt-in/grant exacts
avant lecture. Réutiliser les dépendances pilote sans élargir l'API de mutations
ni donner au request des champs actor/role/grant/policy.

Capturer input/dépendances/snapshot/fonts/octets avant chaque callback await.
Lire par le wrapper privé pilote, valider la révision exacte, rendre le DTO
whitelist, calculer hash et taille, puis refaire une admission complète après
les dernières attentes fonts/render/hash/scope/configuration. Vérifier par head
admis que la révision n'a pas changé pendant ce travail ; sinon409 sans exporter
un autre livre à l'insu de l'utilisateur. Un dernier contrôle Auth/D1/flags
reste nécessaire après l'attente PG. Ces fences ne sont pas une transaction
distribuée et n'annulent pas un document déjà téléchargé.

Réponse seulement après ces contrôles : MIME précis, attachment avec nom ASCII
borné/sûr, `nosniff`, `no-store`, `no-referrer`, Vary cookies+headers de scope,
taille/hash, organisation, consumer/version, révision financière et ledger,
langue/format et hash du selector. Pas de header `X-Zentra-Erp-Revision` qui
laisserait croire à ERP1–4 ni de donnée sensible dans filename/logs.

Session de téléchargement séparée ou extension strictement typée de la session
pilote : org/user/instance/generation capturés ; requête initiée par clic, pas
dans le poll3s. Réponse binaire bornée lue en flux, deadline/cancellation sur
fetch **et body/hash**, contrôle headers/MIME/%PDF/hash/selector/révision avant
Blob.401/402/403 effacent le résultat et terminent l'instance ; changement de
compte/espace/unmount invalide toutes réponses et URL objet.409 propose de
recharger/revoir puis de demander explicitement un nouvel export. Aucun retry
ou retarget automatique ; les brouillons de paiement ne changent pas.

## Fichiers et ordre de livraison proposés

1. Nouveaux `lib/international/us-financial-pilot-export-contract.ts` et
   `us-financial-pilot-export-projection.ts` + leurs tests : selector, DTO
   whitelist, complétude, quatre montants et rapports du livre réel.
2. Nouveau `us-financial-pilot-export-renderer.ts` + tests : PDF/CSV et fontes
   fixes ; libellés FR/DE/IT/EN dans `us-financial-pilot-export-copy.ts`.
3. Nouveau `us-financial-pilot-export-server.ts` + tests et
   `us-financial-pilot-export-bindings.ts`, réutilisant l'admission/scope/store
   existants. Deux routes fines aux chemins ci-dessus ; aucun nouvel RPC requis.
4. Nouveau `browser-us-financial-pilot-export-session.ts` + tests de transport
   fictif, puis commandes de téléchargement dans
   `components/account/us-financial-pilot.tsx` et traductions ; chargement local
   au bouton sans bloquer les mises à jour du livre.
5. Nouvelle recette locale `us-financial-pilot-exports.postgres.test.ts` et
   contrôles de rendu PDF desktop/mobile/4langues ; validation types/lint/build
   et régression ERP1–4/CH seulement à l'ouverture de ce lot après le gel actuel.

Capacité : conserver `postgres-test-financial-pilot-dto1` pour la lecture admise
et le protocole browser DTO1. Aucun flag permettant une écriture fiscale,
aucune ouverture native/ERP5, aucun provisioning de grant. Un éventuel flag
serveur exports peut seulement fermer cette lecture ; il doit être recontrôlé.
Migration : **aucune proposée pour le minimum en lecture seule**. Un futur
export archivé/signé ou envoyé introduirait une mutation, Storage/outbox et un
lot séparé avec autorisation, idempotence, ACL/rétention/audit et migration CLI.

## Tests d'acceptation à exécuter plus tard

- Vraie chaîne locale : baseline ERP4 avec facture/achat, promotion, avoir,
  paiement partiel, journal+contrepassation, fermeture/ouverture, nouvelle
  facture V5 et autres paiements/avoirs. Exports égaux aux projections et vrais
  rapports ; aucune ancienne projection ERP4 utilisée pour un espace promu.
- Exemple arithmétique exact : total107, reçu50, crédit35, restant22. Vérifier
  les quatre valeurs dans snapshot/PDF/CSV sans nommer85 « encaissé ».
- Plus25 paiements/avoirs/mouvements : toutes les lignes attendues, aucun
  doublon, limites1000/texte/pages/octet explicitement refusées ; montants au-delà
  de MAX_SAFE_INTEGER exacts, arrondis déjà émis préservés.
- Grand livre avec périodes closes et audit.length>entries.length, crédits,
  achats et contrepassations ; balance équilibrée, résultat/bilan concordants,
  ARcourant séparé d'asOf et trésorerie non classifiée signalée.
- Auth/tenant/rôle/plan/flags/grant/opt-in/configuration : refus initial et
  révocation pendant store/font/render/hash/dernierawait ; aucun binaire tardif,
  aucun rawbook/provider/EIN dans bytes, headers ou erreur. Deux espaces,
  autre utilisateur, cookies expirés, Authorization/native et paramètres forgés.
- Changement de révision pendant rendu =>409 ; export précédent jamais
  silencieusement retargeté ; appels exports n'altèrent ni tête, événement,
  reçu, fiscalité, facture, stockage ni journal. Vérifier à la couche PG réelle.
- Binaire tronqué/surdimensionné, mauvais hash/MIME/selector/revision/filename,
  body lent, abort et réponse après changement de compte ; URL Blob révoquées.
- PDF vrai Letter lisible FR/DE/IT/EN : accents, notes/adresses/descriptions
  longues, tableaux multipages, entêtes/pieds, glyphes non pris en charge rejetés
  plutôt que supprimés. CSV formules, séparateurs/quotes/nouvelles lignes et
  négatifs numériques. Ne pas supposer que tous les Unicode sont dans Noto Sans.
- Performance mesurée sur une source bornée ; pas de SLA inventé ni test PGlite
  présenté comme concurrence PostgreSQL hébergée. OctetsPDF pas supposés stables
  intergénérations sans verrouillage explicite des métadonnées/identifiants.

## Risques et frontières restantes

La fonte embarquée et la reconstruction intégrale ont un coût mémoire/CPU sur
Workers : lazyimport PDF uniquement, CSV sans fontkit, limites et deadline
mesurées. Pas de cache public ni de stockage d'un payload privé pour accélérer.
Les documents TEST doivent rester identifiés comme tels ; un crédit fiscal
`adjustment_pending` ne constitue pas une correction réalisée chez un prestataire.
En-tête d'entreprise des rapports à décider explicitement faute de nom dans
la configuration ; pas de faux profil. Le scope PG reste un grant TEST local
avec opt-in vivant et non une autorité de production D1 atomique. Les effets
marchands, fiscalité réelle, SLA, signature légale, archivage/rétention et
admission native restent hors périmètre.
