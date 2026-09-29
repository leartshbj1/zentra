# Traitements mails et Automation, applications fermées

Préparation du 29 septembre 2026. Aucun planificateur, secret ou abonnement n’est activé par ce lot.

## Changement serveur

Le planificateur réserve directement la plus ancienne boîte due par une instruction SQLite `UPDATE … RETURNING`. Deux appels ne sélectionnent plus la même boîte avant de tenter de la réserver. L’ordre reste `next_sync_at`, puis l’identifiant de connexion. La réservation porte aussi sur l’espace de la connexion ; les espaces en pause, connexions inactives et autres fournisseurs sont exclus.

L’action manuelle garde sa réservation par identifiant, même avant l’échéance suivante. Son contrat reste inchangé. L’endpoint planifié accepte toujours le POST existant et son corps `{}`, avec le même secret dans l’en-tête Authorization. Aucun paramètre fourni par l’appelant ne peut relever les limites.

Chaque POST engage au maximum **quatre boîtes, deux simultanément**. Après **vingt secondes**, aucune nouvelle boîte n’est réservée. L’unité admise est une boîte avec son lot déjà borné : au plus deux pages de vingt messages, préparation de trois messages avec pièces jointes et cinq analyses de tickets. Ses étapes terminent et leur progression est enregistrée même si l’ouverture, la lecture ou la préparation dépasse le budget. Cela évite de rejouer indéfiniment la même pièce lente sans enregistrer son résultat. Vingt secondes est un budget d’admission, pas une durée maximale de réponse. Toutes les opérations sont attendues ; aucune course de promesses ne laisse de travail détaché après la réponse. Automation conserve son traitement existant de vingt éléments et son propre budget ; ce lot ne le réécrit pas.

Un bail de dix minutes est renouvelé aux frontières des opérations seulement s’il appartient encore au même travail et n’a pas expiré. Les changements de curseur, résultats et nettoyages vérifient le propriétaire. Une erreur tardive ne modifie pas le bail suivant. Ces vérifications n’annulent pas une capture ou une analyse déjà engagée ; leurs protections existantes contre les doublons restent nécessaires. Une erreur recule la boîte de cinq minutes ; un lot incomplet reprend après trente secondes. Le budget d’admission ne supprime aucun contrôle de bail : sa perte ou son expiration interrompt toujours les effets suivants. Une boîte défaillante ne bloque donc pas les suivantes.

La réponse et les diagnostics ajoutent des compteurs : boîtes examinées, échecs, boîtes dues, retard supérieur à quinze minutes, baux actifs, date de la plus ancienne échéance et budget atteint. Ils ne contiennent ni identifiant d’entreprise ni adresse, contenu de mail ou secret.

## Préparation Supabase Cron

`SUPPLIER-MAIL-SCHEDULER.sql` prépare une fonction privée et un registre de requêtes. Il refuse de modifier la fonction si le job nommé existe déjà et est actif. La commande d’activation est volontairement commentée.

Après rétablissement du projet Supabase prévu et validation du secret Vault `zentra_support_mail_sync`, le job peut remplir au maximum **huit créneaux HTTP**, une fois par minute. Chaque requête garde son identifiant `pg_net`. Un créneau occupé n’est pas réutilisé ; une réponse perdue ou interrompue reste incertaine pendant dix minutes. Les résultats sont conservés sept jours, sans en-tête d’authentification ni corps de message.

Le contrôle relit la réponse exacte de chaque requête. HTTP 200 avec `failed:true`, JSON invalide ou contrat manquant est un échec. `more`, `incomplete`, `syncing` et `paused` signalent un résultat partiel. La réussite de `cron.job_run_details` prouve seulement l’exécution SQL, pas la réussite du traitement HTTP.

Les huit créneaux et petits lots rendent possibles jusqu’à 32 visites de boîte par minute si les réponses sont rapides. Ce plafond théorique ne prouve ni une capacité de 150 entreprises, ni un délai de cinq minutes en charge réelle, ni la conformité aux quotas du compte d’hébergement. Les pièces, analyses, limitations fournisseur et baux en cours peuvent réduire le débit. Le retard mesuré doit guider le réglage après recette.

## Validation et activation

Validation locale après intégration : **214 tests passent dans dix fichiers**, et `tsc --noEmit --incremental false` réussit. Trois contre-épreuves reproduisent avant correction l'abandon d'une boîte à la frontière d'une liste, préparation ou capture lente. Après correction, leur résultat est enregistré, les nouvelles admissions s'arrêtent et la perte du bail bloque toujours les effets suivants.

La recette SQLite utilise 150 boîtes fictives : 38 lots au plus, chacune visitée une fois, avec une boîte en panne repoussée et les 149 autres terminées. Les services externes sont simulés. Les tests couvrent également appels simultanés, action manuelle, bail remplacé ou expiré, abonnement refusé, limite d’admission, attente des travaux en vol, authentification et confidentialité des compteurs.

La recette SQL a été exécutée dans PostgreSQL via PGlite, avec `pg_net`, Vault et Cron remplacés par des tables/fonctions locales sans réseau. Elle vérifie le plafond de huit créneaux, HTTP 200 en échec, réponses invalides, états partiels, conservation des délais incertains, reprise après expiration, absence de secret, permissions privées et refus d’un job déjà actif. Elle ne valide pas les extensions ni les droits du projet Supabase réel.

Pour activer : vérifier les extensions et le job existant, provisionner le secret depuis le coffre administrateur sans l’inscrire dans SQL ou les logs, puis activer explicitement le job nommé. Observer plusieurs réponses HTTP corrélées et battements serveur, interfaces fermées, avant d’activer `SUPPORT_MAIL_BACKGROUND_ENABLED`. Une pièce fictive autorisée et sa reprise après interruption restent à vérifier avant d’annoncer le fonctionnement autonome.
