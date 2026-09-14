# Zentra 1.67.0 — Entreprise partagée

Cette version remplace le simple transfert initial de la version 1.66 par une synchronisation continue de la base complète avec Supabase. Un administrateur active explicitement le partage dans Paramètres → Compte et équipe. Les invitations restent nominatives, limitées par la formule (titulaire compris) et soumises au rôle du membre. Le partage complet inclut les salaires et les données comptables ; ce périmètre est annoncé avant activation.

Les créations de devis et factures enregistrent le compte créateur. Le filtre « Créé par » permet de retrouver les documents de chaque personne. Aucun auteur n’est inventé pour les documents historiques.

## Fonctionnement et limites

Les révisions complètes sont privées dans Supabase Storage et Postgres. Le serveur contrôle la session, le membre, le rôle, la formule et l’entreprise à chaque requête. Les tables ne sont pas accessibles directement aux rôles anon/authenticated. Chaque fragment et l’archive complète sont vérifiés par SHA-256. La publication utilise une révision conditionnelle atomique ; une version concurrente ne peut pas écraser une autre version silencieusement. Les numéros de documents sont réservés par appareil via une procédure transactionnelle.

La synchronisation vérifie les changements toutes les 15 secondes lorsque l’application est active. Les envois interrompus sont conservés localement. La réception attend la fin de la saisie. La version complète impose une limite de 512 Mio par archive et 2 Gio de transport conservé par entreprise. Les dix dernières révisions terminées sont conservées, ainsi que les envois non terminés.

Il ne s’agit pas d’une fusion automatique des modifications concurrentes : si plusieurs appareils ont changé la base depuis la même révision, l’utilisateur conserve une sauvegarde locale avant de recevoir la version de l’équipe. Les changements non envoyés doivent ensuite être repris manuellement. Les données et fichiers originaux restent conservés avant ce choix explicite. Les clients 1.66 ne participent pas au partage continu et doivent être mis à jour.

## Validation

- Suite native : 707 tests réussis sur 710, un échec SQLite corrigé puis rejoué avec succès ; deux tests d’environnement ignorés. Les quatre nouveaux scénarios de collaboration ont été rejoués après la correction.
- Tests avec deux bases locales : documents et logo reçus, identité locale conservée, attribution du créateur, refus des écrasements et reprise des envois.
- Migration et procédures exécutées sur PostgreSQL de test : séparation des entreprises, permissions, fragments incomplets, révisions concurrentes, réservations de numéros et idempotence.
- Tests serveur : séparation des entreprises et des appareils, rôles, empreintes, reprise, rétention et chemins Storage privés.
- La migration de production a été appliquée et ses RLS/droits vérifiés le 14 septembre 2026. Aucun jeu de données client n’a été modifié.
- L’essai bout en bout avec deux comptes clients réels et l’installation physique Apple restent à vérifier. Les tests automatisés utilisent des données synthétiques isolées.

La disponibilité des exécutables et leur publication doivent être vérifiées séparément. L’IPA iPhone est non signé ; la version macOS publique utilise une signature ad hoc et une signature du mécanisme de mise à jour, sans notarisation Apple.

## Publication vérifiée le 14 septembre 2026

Les fichiers Apple ont été compilés sur Codemagic depuis `387aa3fc5ff3b8a78a578e925a7c0f35560264c5`, puis téléchargés de nouveau depuis le bucket public Supabase `zentra-releases`. Leurs tailles et SHA-256 correspondent aux sorties locales vérifiées. Le manifeste `latest-macos.json` propose la version 1.67.0 ; sa signature Tauri/Ed25519 a été vérifiée indépendamment. Le manifeste précédent est conservé sous `latest-macos-before-1.67-ui-20260914.json`.

| Fichier | Octets | SHA-256 |
| --- | ---: | --- |
| `Zentra-1.67.0-iPhone-unsigned.ipa` | 25015192 | `3317C6953750CBFB483507767EFFB2BBC2B697A2644C36C0518BCD1E080DD20B` |
| `Zentra_1.67.0_macos-universal.dmg` | 50229767 | `C11DC2BDDDF91FB63D5D25BB643FE7BAD9C02BBFCE6FD656AE2ABC91ADB3A920` |
| `Zentra_1.67.0_macos-universal.app.tar.gz` | 50207586 | `D25CEE15D3DF1C73250CC223FCFBEC128DA23408083B8E69EB964C8034EDCAF5` |

La page publique de téléchargement et l’API ont été déployées depuis `d21ad460ca92092f49fa84a9fe5a5222fa20e3e5` (publication Sites 140). Les 31 tests serveur ciblés et TypeScript passent. Le test WebKit de réception confirme que la saisie diffère l’application distante et que les commandes restent inactives jusqu’au chargement de l’entreprise reçue. Les filtres par créateur passent en clair et sombre à 320, 390 et 1280 pixels.

L’exécutable Windows a été compilé depuis `9a435194cbc61a3258a93df982c7d3fa4e667614`. Ce commit ajoute uniquement les règles de palette générées à la source Apple ; la compilation Apple les génère également. Après fermeture de l’application utilisateur, les six essais isolés ont réussi : démarrage et redémarrage de la 1.67, initialisation puis données synthétiques dans la 1.61, remplacement par la 1.67 et redémarrage après migration. Les anciennes lignes métier, écritures équilibrées, numéros, pièces jointes et identité protégée sont conservés. La base passe du schéma 59 au schéma 60 et ses contrôles d’intégrité et de clés étrangères passent. Ce test exécute le binaire distribué ; il ne simule pas l’assistant NSIS ni une interaction complète avec des comptes clients. Aucun test n’a été exécuté sur les données de l’utilisateur.

Le canal Windows `latest-windows.json` propose désormais la 1.67.0. Son manifeste précédent est conservé sous `latest-windows-before-1.67-ui-20260914.json`. Le téléchargement public et la signature Tauri/Ed25519 ont été vérifiés de nouveau avant promotion. Fichier : `Zentra_1.67.0_x64-setup.exe`, 23476922 octets, SHA-256 `CDD697AD4A08CFEA086213B465453918C15D89607A4B7FAEF48D0BD35BB58392`. Le manifeste partagé historique `latest.json` reste en version 1.46.1 et le canal Mac reste en 1.67.0. Le site annonce également Windows 1.67 depuis la source `eae8959564ac4b719e5e67a0481d86ddebebabd6` (publication Sites 141).
