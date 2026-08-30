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

- Abonnement Stripe Checkout fixé côté serveur à 50 CHF par mois; le navigateur ne choisit ni le prix ni le plan.
- Webhook Stripe vérifié sur le corps brut, avec journal d’événements idempotent dans D1.
- Jeton de licence Ed25519 à durée courte, lié à l’identifiant DPAPI d’une installation Windows.
- Sans licence valide, l’application passe en lecture seule sans supprimer les données; sauvegarde et export restent disponibles.
- Seuls l’état d’abonnement et l’identifiant d’installation sont traités côté serveur. Les clients, factures, salaires, heures, projets et chantiers restent dans SQLite sur le PC.

Les secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` et `LICENSE_SIGNING_KEY_PKCS8_B64URL` doivent exister uniquement dans les variables secrètes de l’hébergement. `PUBLIC_SITE_URL` fixe l’origine publique autorisée. Le webhook Stripe doit viser `/api/stripe/webhook` et utiliser la version API `2025-03-31.basil`.

## Développement

```powershell
pnpm install
pnpm build
pnpm --dir desktop build:web
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --all-targets
```

L’installateur Windows est produit avec :

```powershell
pnpm --dir desktop build
```

La release embarque la clé publique versionnée dans `desktop/src-tauri/license-public-key.b64url`; le build échoue si elle est absente ou invalide. La clé privée n’est jamais incluse dans le dépôt ni dans l’application.

## Livraison Windows

La version de validation `1.1.4` est disponible dans `public/downloads`. Avant une diffusion commerciale générale, signer l’exécutable et l’installateur avec un certificat Authenticode horodaté. La licence augmente fortement le coût d’un partage ou d’une modification non autorisée, mais aucun logiciel exécuté sur un ordinateur contrôlé par l’utilisateur ne peut être garanti absolument incrackable.
