# HelviChantier

HelviChantier réunit deux produits dans ce dépôt :

- une véritable application Windows x64 basée sur Tauri, React et SQLite ;
- un site commercial avec téléchargement direct de l’installateur.

## Principes du logiciel

- Base SQLite locale dans le dossier de données de l’application Windows.
- Aucun client, chantier, devis, montant ou salarié de démonstration.
- Questionnaire obligatoire au premier lancement.
- Devis, factures, paiements, chantiers, heures, dépenses, rentabilité, employés et fiches de salaire.
- Sauvegarde/restauration locale au format `.hchantier` et export JSON.
- Aucun envoi de données métier à un serveur HelviChantier.

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

## Livraison Windows

La version de validation `1.0.0` est disponible dans `public/downloads`. Avant une diffusion commerciale générale, reconstruire le profil release sur un poste Windows autorisant la chaîne Rust, puis signer l’exécutable et l’installateur avec un certificat Authenticode horodaté.
