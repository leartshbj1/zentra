# Accès offerts depuis le PC fondateur

L’application Windows `founder-signer` accorde un accès individuel à une adresse de connexion confirmée. Les durées sont 14 jours, un mois calendaire ou une date de fin incluse, en heure suisse. La durée démarre à l’attribution ; une prolongation prédéfinie commence après l’échéance active. L’application peut retirer l’offre.

## Authentification et stockage

`POST /api/founder/access` accepte une enveloppe Ed25519 avec le préfixe signé `zentra-founder-access-v1\n`, une version, une heure à cinq minutes près et un nonce conservé 660 secondes. Seule `FOUNDER_ADMIN_PUBLIC_KEY_B64URL` est configurée côté hébergement. La clé privée dédiée, distincte de la clé des licences, reste chiffrée par DPAPI dans le coffre du compte Windows fondateur. Aucun accès administrateur n’est ajouté aux pages Web ou aux applications clientes.

Les modifications utilisent une référence d’opération et une révision attendue. La modification et son reçu sont atomiques. Le PC conserve la demande chiffrée avant de l’envoyer ; une réponse perdue peut être récupérée sans prolongation double. Les écritures concurrentes périmées sont refusées. Le protocole rejette les requêtes avec un en-tête Origin, sans dépendre de ce seul en-tête pour la sécurité.

La migration 0040 ajoute les identités confirmées, les offres, leurs reçus et les nonces. L’offre est attachée définitivement à une identité et une entreprise ; la réattribution ultérieure d’une adresse e-mail ne transfère pas cet accès. Le changement d’adresse d’un même compte ne permet pas de prendre une deuxième offre. Une identité est enregistrée uniquement à partir de l’authentification serveur existante.

## Activation et paiements

Une entreprise détenue uniquement par le bénéficiaire au sens d’unique entreprise propriétaire est réutilisée ; s’il n’en détient aucune ou plusieurs, un espace personnel distinct est créé. Un abonnement interne `manual_…` n’est jamais présenté comme un paiement Stripe : aucun numéro de facture payé, aucun droit payé et aucune transaction ne sont fabriqués.

Les droits offerts s’appliquent à l’identité propriétaire vérifiée uniquement. Les droits d’un abonnement payé restent indépendants. Les appareils passent par le parcours existant : code appareil, approbation par le compte, session personnelle et licence Ed25519 compatible avec les clients déployés. Le renouvellement vérifie l’offre à chaque requête ; les accès manuels expirés ou retirés n’appellent pas Stripe. Les accès serveur et les nouvelles connexions sont bloqués dès le retrait ou l’échéance.

Les anciens clients utilisent des dates, sans heure, dans les licences signées. Un appareil hors ligne peut donc rester actif jusqu’à la fin du dernier jour couvert par sa licence. Les licences offertes ont un bail d’au plus un jour avant arrondi au jour, sans les trois jours de grâce des abonnements payés. Le site affiche explicitement une offre, y compris lorsqu’elle est terminée.

## Vérification

- 61 tests ciblés : offres/signatures/rejeu/échéances, authentification du compte, licences existantes, places et parcours appareil. Base SQLite recréée avec toutes les migrations ; vérification de l’attribution, du rattachement, de l’activation, du renouvellement et du retrait.
- Tests Rust : signature avec séparation des domaines, clé DPAPI persistante, demande chiffrée récupérée au redémarrage et conflits de demandes ; tests de licence existants conservés.
- Parcours d’interface en deux tailles, avec reprise d’une réponse perdue sans double écriture. `founder-signer/tests/access-native.mjs` vérifie le véritable exécutable contre le service déployé avec une adresse `.invalid`, puis retire l’offre de test. Aucun e-mail n’est envoyé.
- Contrôle TypeScript, lint ciblé et compilation du site.

La suite générale du dépôt contient également des tests métier et d’anciennes fixtures hors de ce changement. Son exécution élargie n’est pas une validation entièrement verte : des tests de numérotation, de checkout et de calculs/projections D1 ont échoué ou dépassé leur délai. La suite ciblée ci-dessus couvre les parcours modifiés. Les fixtures d’inscription ciblées ont été remises en accord avec l’acceptation légale déjà requise par la version publiée.

Le programme personnel n’est pas signé par un certificat Authenticode. L’installation locale maintient les permissions du coffre, copie WebView2Loader.dll et conserve les clés déjà présentes. Le mode d’emploi se trouve dans `founder-signer/README.md`.
