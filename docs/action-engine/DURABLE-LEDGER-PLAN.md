# A1 — registre durable et réservation, périmètre local

## Décision d'architecture

Le registre D1 conservera la proposition canonique, une réservation unique et le reçu final. Il ne créera pas directement les tables Gestion et ne remplacera pas leur protocole de synchronisation. Aucune route ni aucun worker ne sera activé dans ce lot.

L'unicité est **entreprise + source + type**, indépendante de l'appareil et des révisions ultérieures du mail. Une empreinte différente sur cette même identité produit un conflit. La proposition d'origine ne sera ni écrasée ni supprimée. Les propositions à vérifier ne pourront pas être réservées.

La première réservation attribuera des identifiants métier stables au client éventuel et au devis. Elle restera liée à l'utilisateur et à l'installation authentifiés. **Aucun délai, libération ou transfert automatique** : après perte de réponse, seule cette réservation pourra être reprise. Une autre installation attendra le rapprochement du reçu. Ce choix privilégie l'absence de doublon à une fausse garantie de reprise immédiate.

Un reçu ne prouve pas à lui seul l'existence du devis partagé. Sa confirmation devra comparer une publication business-sync canonique effectivement validée : entreprise, identifiants, provenance, empreinte, état de création et reçu. Un JSON fourni par le navigateur ou l'application ne suffit pas. La future commande native utilisera les IDs réservés dans une transaction unique et un outbox privé.

## Autorisation atomique sans miroir périmé

Les abonnements existants combinent Stripe, prépayé, pack, essai et délégation. Les recopier dans une nouvelle table d'autorisation créerait un risque de droits périmés. Le registre exigera donc une **barrière SQL interne obligatoire**, construite exclusivement par le serveur et exécutée dans la même transaction D1 que la mutation. Aucun prédicat par défaut permissif.

Cette interface est une frontière explicite encore à raccorder, pas une preuve que l'admission complète est déjà implémentée. La future composition devra contrôler session actuelle, membre, rôle, siège, droits Gestion + Automation, consentement et action activée. L'enregistrement et la réservation compareront aussi source et catalogue courants. La récupération historique et la confirmation après commit ne devront pas dépendre d'un ancien catalogue devenu obsolète.

La composition devra d'abord corroborer le plan contre une projection autorisée avec `validatePlanAgainstContext`, puis lier ses versions exactes à l'assertion SQL. Une empreinte seule ne prouve pas la vérité des lignes. Les branches commerciales/session non recorroborées seront refusées. La reprise d'une réservation non confirmée sur le même appareil repasse la barrière `reserve` ; le simple droit de lire l'historique n'autorise pas une nouvelle écriture.

Le contexte couvre aussi l'index d'identité des clients : client existant toujours actif et même révision, e-mail unique, ou absence de correspondance active/archivée pour un nouveau client. Une autre création du même client après la proposition doit invalider cette préparation. Une révision de catalogue seule serait insuffisante. La commande native devra répéter ce contrôle dans sa transaction métier.

Le prédicat est du code serveur ; ses valeurs sont liées par paramètres. Il ne sera jamais un champ d'API. Une assertion CHECK dans le batch doit faire échouer toute la transaction si la barrière est fausse ou NULL. Le journal doit rester cohérent avec le changement confirmé.

## Migration proposée

Migration D1 additive `0099_action_engine_quote_ledger.sql`, générée avec `wrangler d1 migrations create` contre une configuration locale sans identifiants de production : propositions immuables, réservations, événements append-only et assertions transactionnelles éphémères. Pas de modification des tables existantes, données, RLS ou région Supabase. Les tests appliqueront l'historique complet sur SQLite et le nouveau SQL dans le simulateur D1 embarqué. Aucun déploiement distant.

Le journal de métadonnées Drizzle s'arrête actuellement à 0087 alors que les fichiers SQL historiques vont à 0098. Une génération custom Drizzle initiale a produit un préfixe 0088 en collision ; ses seuls nouveaux fichiers et son ajout au journal ont été retirés avant implémentation. Wrangler a ensuite créé 0099 depuis le véritable répertoire de migrations. Aucun historique existant n'a été réécrit. Le nouveau schéma est exporté dans `db/action-engine-schema.ts` ; les contraintes et triggers restent explicitement dans la migration SQL. Une réparation globale des métadonnées demeure hors de ce lot.

Le retour arrière opérationnel consiste à garder l'intégration désactivée et à revenir au code précédent, en conservant les tables et preuves. Une suppression de tables n'est pas un retour arrière sûr après des effets métier. La rétention et l'effacement réglementaire demanderont un parcours administratif distinct et audité.

## Contrôles prévus

- Répétition concurrente, rechargement d'une nouvelle instance, empreinte différente.
- Entreprise étrangère, droits révoqués avant le batch, prédicat absent/faux/NULL.
- Modification et suppression directes interdites par SQL.
- Tables immuables sans `rowid` implicite ; remplacement interdit par toutes leurs clés uniques, même sans triggers récursifs.
- Un seul propriétaire d'exécution ; même installation autorisée à retrouver ses IDs.
- Aucun transfert après temps écoulé, même en cas de résultat incertain.
- Reçu lié aux IDs réservés, confirmation idempotente, reçu différent refusé.
- Panne SQL et perte de réponse : aucune mutation partielle, reprise par lecture.
- Journal sans contenu du mail, prix ni secrets.

## Écart natif corrigé avant raccord

Le schéma natif 1.90.15 conserve le numéro d'un devis brouillon à NULL ; la numérotation intervient à l'émission. Le contrat initial du noyau exigeait à tort un numéro non vide. Il sera corrigé : aucun faux numéro qui figerait le devis ne doit être créé pour satisfaire un DTO.
