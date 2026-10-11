# Adaptateur Gestion A3 — sources privées, validation native en attente

## Portée

Le desktop 1.90.15 de app-current-corrections possède les sources d'un writer privé LocalStore::commit_action_engine_quote_draft, d'une projection et d'une migration additive 61→62. Aucun IPC, accès réseau, contrôle WebView ou déclenchement Support n'est ajouté. Ce writer n'est pas utilisable depuis l'application publiée.

La tentative cargo check --locked --lib est bloquée par Windows App Control sur des build scripts de dépendances, avant compilation de ces modules. Rustfmt lit la syntaxe, et les tests serveur exécutent le SQL62 avec SQLite réel ; cela ne remplace ni la compilation Rust ni les tests LocalStore.

## Entrée fermée

Plan TypeScript canonique transmis en chaîne UTF-8, SHA-256, proposition, réservation centrale, source complète, acteur, installation, origine locale, génération de contexte membre, hash ressources, révision de contexte et IDs client/devis réservés. Serde refuse les champs inconnus/dupliqués. Le fingerprint porte sur les octets TS d'origine, jamais sur une re-sérialisation Rust.

Le futur caller authentifié doit revalider l'admission distante, la réservation permanente et la source/publication actuelle. Cet input privé ne constitue pas une permission. L'installation est corroborée avec LocalStore, organisation/utilisateur/rôle avec company_local_identity, origine/génération avec les protections existantes. Un token de WebView ne vaut pas authentification serveur.

## Transaction codée

Sous mutex local unique, droit d'écriture/licence locale et transaction SQLite IMMEDIATE :

1. Onboarding, origine et contexte membre frais.
2. Reçu historique avant ressources actuelles. Le même contrat retourne le fait original sans modifier, écraser ou recréer un devis ensuite édité/émis/supprimé. Une autre empreinte/réservation/installation donne un conflit.
3. Hash de toutes les ressources relues, révisions client/article et identité unique par e-mail. Un client archivé seul ou plusieurs actifs imposent une revue ; créer un client exige l'absence de toute correspondance.
4. Corroboration des lignes : nom, unité, prix/taux configurés, archive, quantité littérale bornée. Le parseur Rust peut refuser des formulations plus larges acceptées par le préparateur ; il ne devine pas.
5. Client conditionnel et vrai devis brouillon, numéro NULL, lignes à IDs stables. Aucune émission, réservation de numéro, facture, paiement, mouvement de stock ou écriture comptable.
6. Calculs cents/millièmes/i128, arrondi positif half-up. Taux effectif zéro pour non-assujetti. La colonne REAL de quantité sert à l'affichage ; preuve et calculs restent entiers.
7. Reçu partagé, audit, provenance via triggers existants et outbox privée atomiques ; rollback si une étape échoue.

La date du brouillon suit le calendrier local de l'appareil, comme le parcours CH actuel. Sa validité utilise le délai de l'entreprise. L'utilisateur doit relire avant émission. Aucune règle fiscale nouvelle n'est annoncée.

## Reçu et outbox

action_engine_quote_receipts est append-only, WITHOUT ROWID, unique par entreprise/source/type, proposition, réservation et devis. Les gardes BEFORE INSERT empêchent aussi REPLACE/IGNORE. Pas de FK au devis/client : supprimer un brouillon ne supprime pas la preuve historique. Le reçu reste quoteNumber:null, status:draft, validation humaine requise, même après émission ultérieure.

company_local_action_engine_quote_outbox contient seulement IDs, empreintes et hash du reçu. FK et trigger exigent le reçu correspondant. Identité/payload immuables ; état/compteurs/horodatages progressent sans retour d'un état confirmé. Aucun nom, e-mail, corps, prix, nonce ou bearer enregistré.

strip_private retire l'outbox des archives. La réception conserve l'outbox locale ; rejoindre une autre entreprise la vide. Les reçus restent partagés. Avant remplacement reçu/fusionné, chaque reçu local doit être retrouvé identique ; sinon la restauration est annulée avec explication et les données précédentes sont rétablies. Une preuve incertaine n'est pas purgée pour permettre une nouvelle création.

Les références de fusion v60/v61 sont normalisées additivement vers 62 dans des copies temporaires validées, jamais dans les archives sources. La fusion intermédiaire retire le descripteur de ressources absent ; la republication le reconstruit sur sa nouvelle copie figée.

## Validation restante avant exposition

- Compiler et exécuter les 50 nouveaux tests natifs : ressources 20, writer 22, archives 4, réception 3, fusion 1 (deux versions anciennes).
- Produire une vraie archive synthétique native et la passer au codec TS. Les ZIP manuels des tests serveur ne constituent pas cette preuve.
- Exécuter les régressions natives de restauration/fusion, doubles connexions, arrêts/reprises et changement d'entreprise/compte.
- Raccorder admission/réservation/source distantes, preuve métier canonique publiée et acquittement durable. Ni un reçu déclaré par le client ni un SHA du sidecar ne suffisent.
- Exposer ensuite une commande unique, intégrer Activité/À suivre et ouvrir le vrai devis courant. Notifier uniquement après confirmation métier corroborée.

Aucune garantie distribuée « exactly once », conformité fiscale, création en ligne ou synchronisation entre appareils physiques n'est revendiquée par ce lot.
