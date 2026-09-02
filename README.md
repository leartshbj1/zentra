# Zentra

Zentra 1.19 réunit deux produits dans ce dépôt :

- une véritable application Windows x64 et une cible macOS universelle (Intel + Apple Silicon) basée sur Tauri, React et SQLite ;
- un site commercial avec téléchargement direct de l’installateur.

## Principes du logiciel

- Base SQLite locale dans le dossier de données de l’application Windows ou macOS.
- Aucun client, projet, chantier, devis, montant ou salarié de démonstration.
- Questionnaire obligatoire au premier lancement, avec section et division NOGA 2025 puis description précise de l’activité.
- Checklist de prise en main calculée uniquement à partir des vraies données locales : client, projet, devis accepté, facture issue du devis, paiement comptabilisé et première sauvegarde. Aucun état de réussite simulé ou coché manuellement.
- Interface multisectorielle : le vocabulaire du module projets / dossiers / chantiers s’adapte au domaine choisi.
- Devis, factures, paiements, projets et chantiers, heures, dépenses, rentabilité, employés, fiches de salaire et comptabilité en partie double.
- Agenda local léger réunissant les rendez-vous saisis et les échéances déjà présentes, sans charger de service externe au démarrage.
- Sauvegarde/restauration locale au format `.zentra`, avec import compatible des formats historiques `.elyko` et `.hchantier`, et export JSON.
- Fonctionnement local par défaut. La connexion au compte transmet uniquement les données techniques nécessaires à l’authentification, aux rôles et à la licence.
- Coffre de factures optionnel : seuls les PDF explicitement archivés sont envoyés au stockage Zentra. Les autres clients, salaires, heures, projets et écritures restent dans SQLite sur l’appareil.
- Une facture émise, y compris payée, n’est jamais réécrite : le flux « Corriger » prépare un avoir intégral et une facture de remplacement liés à l’original et au motif.

## Paiement et licence

- Abonnement Stripe Checkout hébergé, fixé côté serveur à 50 CHF par mois, taxe incluse lorsqu’elle s’applique, au moyen d’un Price stable; le navigateur ne choisit ni le prix ni le plan.
- Toutes les fonctionnalités et tous les collaborateurs sont inclus dans ce prix. Il n’existe ni module ni siège payant supplémentaire.
- Stripe Billing émet les factures récurrentes, Stripe Tax calcule la fiscalité et le portail client donne accès aux factures, au moyen de paiement et à la résiliation en fin de période.
- Webhook Stripe vérifié sur le corps brut, avec version API Dahlia, garde test/live et traitement D1 idempotent même en cas de livraisons concurrentes.
- La licence n’est avancée que par une ligne Zentra non proratisée d’une `invoice.paid`; ni le succès visuel de Checkout ni le statut courant de l’abonnement ne prouvent seuls le paiement d’une période.
- Jeton de licence Ed25519 à durée courte, lié à l’identité protégée d’une installation (DPAPI sous Windows, Trousseau sous macOS).
- Sans licence valide, l’application passe en lecture seule sans supprimer les données; sauvegarde et export restent disponibles.
- Le compte d’entreprise rattache l’abonnement à un propriétaire, un nombre illimité de collaborateurs, des rôles (administrateur, comptable, membre ou lecture seule) et des appareils révocables. Le serveur ne conserve que des empreintes des secrets de session.
- Le coffre conserve chaque version de PDF comme une entrée append-only avec empreinte SHA-256, chaînage, auteur et échéance calculée dix ans après la fin de l’exercice. Il n’existe pas de route de suppression.
- L’application reste local-first : aucune synchronisation générale des clients, salaires, projets ou écritures n’est implicite. Seules les factures que l’utilisateur archive volontairement sont copiées dans le coffre partagé de l’entreprise.

Les secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` et `LICENSE_SIGNING_KEY_PKCS8_B64URL` doivent exister uniquement dans les variables secrètes de l’hébergement. `STRIPE_PRICE_ID` contient l’identifiant non secret du Price mensuel stable et `STRIPE_WEBHOOK_ENDPOINT_ID` l’identifiant non secret de l’endpoint vérifié avant Checkout. La licence propriétaire de recette, si elle est activée, est autorisée uniquement par l’empreinte de son couple licence/installation dans `OWNER_LICENSE_BINDING_SHA256`; le serveur réémet toujours un bail daté de l’heure serveur. `PUBLIC_SITE_URL` fixe l’origine publique HTTPS autorisée. Le webhook Stripe doit viser `/api/stripe/webhook`, être créé avec la version API `2026-08-26.dahlia`, puis livrer un événement canari signé; Checkout reste fermé si le secret courant n’a jamais été prouvé.

Le déploiement Sites doit aussi relier la base D1 sous le binding `DB` et le
bucket R2 sous `FILES`, puis appliquer toutes les migrations Drizzle dans
l’ordre. D1 contient les abonnements, membres, appareils et preuves d’archive ;
R2 contient uniquement les PDF volontairement archivés. Les contrôles
append-only applicatifs et les empreintes détectent une modification, mais ne
constituent pas à eux seuls une certification Olico ni un stockage WORM.

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

Sur un Mac équipé des certificats Apple et des secrets de signature Tauri, le
build universel Intel + Apple Silicon produit le `.dmg`, le `.app` et
l’archive `.app.tar.gz.sig` utilisée par les mises à jour :

```bash
pnpm --dir desktop build:macos
```

Le script refuse de produire un lot public sans identité Developer ID,
identifiants de notarisation Apple et clé privée de signature des mises à jour.

Le workflow GitHub Actions **Zentra macOS preview** produit un `.app.zip` et un
`.dmg` universels signés ad hoc. Le DMG validé est aussi publié sur la page de
téléchargement Zentra en accès anticipé. Il ne contient aucun secret et
n’alimente pas encore le canal de mise à jour. Gatekeeper peut demander une
autorisation manuelle dans Réglages système > Confidentialité et sécurité :

```bash
pnpm --dir desktop build:macos:preview
```

La signature ad hoc permet une installation immédiate, mais n’atteste pas
l’identité de l’éditeur auprès d’Apple. Une distribution sans étape Gatekeeper
exige un Developer ID et la notarisation Apple.

Une release publiable avec mise à jour intégrée doit toujours passer par le
wrapper de signature Tauri/Ed25519 :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/build-local-signed-updater.ps1
```

La release embarque la clé publique versionnée dans `desktop/src-tauri/license-public-key.b64url`; le build échoue si elle est absente ou invalide. La clé privée n’est jamais incluse dans le dépôt ni dans l’application.

## Livraison et limites de certification

La version `1.19.1` ajoute l’agenda local, l’import contrôlé d’un e-mail fournisseur exporté en `.eml` ou en texte et les fondations du compte d’entreprise multi-utilisateur. L’analyse utilise des règles déterministes locales, sans IA et sans connexion directe à la boîte mail. Elle crée seulement un brouillon : l’utilisateur confirme le fournisseur, l’échéance, la catégorie, le règlement et la comptabilisation. Le build macOS universel produit par GitHub Actions est publié en accès anticipé avec une signature ad hoc, sans certificat Apple, sans notarisation et sans canal de mise à jour. Gatekeeper peut donc demander une autorisation manuelle au premier lancement. Un certificat Developer ID Application et la notarisation Apple supprimeront cette étape supplémentaire.

La version `1.18.0` avait ajouté une checklist de démarrage fondée uniquement sur les objets réellement enregistrés, une clôture comptable et TVA cumulative et un traitement local documenté des salaires de minime importance. Toute date antérieure ou égale à la fin de la dernière clôture définitive est scellée, y compris dans un intervalle qui n'aurait pas été clôturé séparément ; seul un rejeu strictement identique reste permis, tandis qu'une correction doit être postérieure et référencer l'original. Pour la paie, Zentra dérive le cumul annuel local, la base éventuellement à rattraper et conserve la décision, sa date, sa preuve et la trace de calcul ; il distingue le seuil ordinaire de CHF 2'500, l'exception de CHF 750 dans un ménage privé jusqu'à la fin de l'année des 25 ans et les secteurs toujours cotisants. L'exception LAA n'est proposée que si les conditions sont documentées pour tous les salariés concernés de l'année.

Le modèle SmolVLM reste générique, local et soumis à une validation humaine ; il n'est pas présenté comme un moteur suisse certifié. Zentra ne calcule pas encore la QST de manière autonome, ne couvre pas tous les règlements LPP ni toutes les clauses IJM, ne génère ni certificat annuel ni déclaration ELM et ne revendique aucune certification Swissdec, AFC ou Olico. La version publique n’est remplacée qu’après recette de l’installateur et publication explicite. Avant une diffusion commerciale générale, signer aussi l’exécutable et l’installateur avec un certificat Authenticode horodaté.

La liaison de licence repose sur un identifiant d’installation aléatoire protégé par Windows DPAPI ou le Trousseau macOS. Elle bloque le partage ordinaire du jeton et détecte les modifications usuelles, mais ce n’est pas une attestation matérielle : un administrateur local très avancé peut encore tenter de cloner cet identifiant ou de modifier le programme. Le durcissement commercial suivant consiste à utiliser une clé de périphérique non exportable TPM/CNG ou Secure Enclave, un défi signé côté serveur et une signature de distribution horodatée.
