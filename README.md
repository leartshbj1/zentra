# Elyko

Elyko réunit deux produits dans ce dépôt :

- une véritable application Windows x64 basée sur Tauri, React et SQLite ;
- un site commercial avec téléchargement direct de l’installateur.

## Principes du logiciel

- Base SQLite locale dans le dossier de données de l’application Windows.
- Aucun client, projet, chantier, devis, montant ou salarié de démonstration.
- Questionnaire obligatoire au premier lancement, avec section et division NOGA 2025 puis description précise de l’activité.
- Interface multisectorielle : le vocabulaire du module projets / dossiers / chantiers s’adapte au domaine choisi.
- Devis, factures, paiements, projets et chantiers, heures, dépenses, rentabilité, employés, fiches de salaire et comptabilité en partie double.
- Sauvegarde/restauration locale au format `.elyko`, import compatible avec l’ancien format `.hchantier`, et export JSON.
- Aucun envoi de données métier à un serveur Elyko.

## Paiement et licence

- Abonnement Stripe Checkout hébergé, fixé côté serveur à 50 CHF par mois au moyen d’un Price stable; le navigateur ne choisit ni le prix ni le plan.
- Stripe Billing émet les factures récurrentes, Stripe Tax calcule la fiscalité et le portail client donne accès aux factures, au moyen de paiement et à la résiliation en fin de période.
- Webhook Stripe vérifié sur le corps brut, avec version API Dahlia, garde test/live et traitement D1 idempotent même en cas de livraisons concurrentes.
- La licence n’est avancée que par une ligne Elyko non proratisée d’une `invoice.paid`; ni le succès visuel de Checkout ni le statut courant de l’abonnement ne prouvent seuls le paiement d’une période.
- Jeton de licence Ed25519 à durée courte, lié à l’identifiant DPAPI d’une installation Windows.
- Sans licence valide, l’application passe en lecture seule sans supprimer les données; sauvegarde et export restent disponibles.
- Seuls l’état d’abonnement et l’identifiant d’installation sont traités côté serveur. Les clients, factures, salaires, heures, projets et chantiers restent dans SQLite sur le PC.

Les secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` et `LICENSE_SIGNING_KEY_PKCS8_B64URL` doivent exister uniquement dans les variables secrètes de l’hébergement. `STRIPE_PRICE_ID` contient l’identifiant non secret du Price mensuel stable. La licence propriétaire de recette, si elle est activée, est autorisée uniquement par l’empreinte de son couple licence/installation dans `OWNER_LICENSE_BINDING_SHA256`; le serveur réémet toujours un bail daté de l’heure serveur. `PUBLIC_SITE_URL` fixe l’origine publique HTTPS autorisée. Le webhook Stripe doit viser `/api/stripe/webhook` et être créé avec la version API `2026-08-26.dahlia`.

Le guide de configuration, la liste exacte des événements et la recette sandbox se trouvent dans [docs/STRIPE-INTEGRATION.md](docs/STRIPE-INTEGRATION.md). Le SDK `stripe@22.6.0` et la version d’API Dahlia sont épinglés ensemble afin que les objets reçus par le webhook correspondent exactement aux types compilés.

## Développement

```powershell
pnpm install
pnpm build
pnpm --dir desktop build:web
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --all-targets
```

Le build Windows local de développement est produit avec :

```powershell
pnpm --dir desktop build
```

Une release publiable avec mise à jour intégrée doit toujours passer par le
wrapper de signature Tauri/Ed25519 :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/build-local-signed-updater.ps1
```

La release embarque la clé publique versionnée dans `desktop/src-tauri/license-public-key.b64url`; le build échoue si elle est absente ou invalide. La clé privée n’est jamais incluse dans le dépôt ni dans l’application.

## Livraison Windows

La version `1.12.0` ajoute un cycle de relances supervisées, local et traçable, puis est préparée avec un manifeste et une signature Tauri/Ed25519 pour les mises à jour intégrées. Avant une diffusion commerciale générale, signer aussi l’exécutable et l’installateur avec un certificat Authenticode horodaté. La licence augmente fortement le coût d’un partage ou d’une modification non autorisée, mais aucun logiciel exécuté sur un ordinateur contrôlé par l’utilisateur ne peut être garanti absolument incrackable.

La liaison de licence actuelle repose sur un identifiant d’installation aléatoire protégé par Windows DPAPI. Elle bloque le partage ordinaire du jeton et détecte les modifications usuelles, mais ce n’est pas une attestation matérielle : un administrateur local très avancé peut encore tenter de cloner cet identifiant ou de modifier le programme. Le durcissement commercial suivant consiste à utiliser une clé de périphérique non exportable TPM/CNG, un défi signé côté serveur et une signature Authenticode horodatée.
