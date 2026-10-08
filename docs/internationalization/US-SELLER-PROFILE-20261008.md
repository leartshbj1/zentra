# Coordonnées du vendeur US — livraison incrémentale locale

Base : `50d125b4dc7650153c9e7caa4ef112840efefdc6`. Cette tranche poursuit le pilote international dans sa copie isolée. Le site commercial publié reste la version 354 ; aucun paquet natif, tarif USD, migration ou activation US de production n'est livré ici.

## Modifications

Un profil vendeur dédié à chaque espace US stocke uniquement le nom affiché, l'e-mail et le téléphone publics. Il ne lit ni ne remplace `zentra_company_profiles` de l'édition suisse. L'absence de profil reste explicite, sans nom inventé ou reprise automatique d'une ancienne entreprise. Les identifiants fiscaux privés, liens de logo, secrets SMTP et champs d'autorité sont refusés.

La lecture et la modification passent par deux RPC PostgreSQL internes et une API `/api/international/workspaces/[organizationId]/seller`. Seul le propriétaire admis et titulaire des droits Gestion US actuels peut modifier le profil ; les membres autorisés peuvent le consulter. Le propriétaire inclut une révision attendue et un identifiant de demande UUID. La transaction conserve son reçu et son ancienne valeur dans un historique immuable, puis modifie le profil courant. Une reprise avec la même identité et le même contenu retrouve le reçu original, même après une modification plus récente, sans remplacer le profil actuel. Les conflits ne deviennent pas des écrasements silencieux.

La frontière HTTP vérifie le compte attendu, l'entreprise, le rôle, les droits, la configuration US/USD, l'origine des écritures navigateur et les flags. Elle relit la configuration privée sous l'acteur initial, puis l'autorité fraîche et les flags juste avant le RPC et avant sa réponse. Les refus et diagnostics contiennent seulement des codes et statuts. Une révocation tardive retient le résultat d'une écriture déjà enregistrée ; elle n'efface ni ne recommence cette transaction. La récupération exige une réauthentification et exactement la même demande.

Le moteur de facturation lit désormais ce profil US pour construire le snapshot public du vendeur. Les factures déjà émises conservent leur identité historique. Ce raccordement ne débloque pas encore l'émission : le prestataire fiscal reste absent et le parcours de paramètres vendeur dans le navigateur est une étape suivante.

Le [contrat fiscal proposé](US-TAX-PROVIDER-CONTRACT-20261008.md) documente les comptes vendeurs, registrations, codes produits, justificatifs d'exemption, motifs de taxe zéro, fuseaux, arrondis, preuves privées et cycles de transaction fiscale. Ces exigences reposent sur la documentation primaire actuelle ; le document ne constitue ni une intégration Stripe Tax exécutée ni une validation réglementaire. Les taxes ERP d'une entreprise restent distinctes des taxes sur son abonnement Zentra.

## Fichiers

Créés : `lib/international/seller-profile.ts`, `seller-profile.test.ts`, `seller-profile.postgres.test.ts`, `seller-profile-server.ts`, `seller-profile-server.test.ts` ; `app/api/international/workspaces/[organizationId]/seller/route.ts` ; `supabase/migrations/20261008034422_international_us_seller_profile.sql` ; `scripts/qa-us-seller-regression.mjs` ; le contrat fiscal, ce rapport et la preuve JSON associée.

Modifiés : `lib/international/runtime-bindings.ts`, `runtime-bindings.test.ts` et la liste attendue des migrations dans `workspace-creation.integration.test.ts`. Aucune refonte des fichiers natifs ou publics, ni modification des transports, devises ou abonnements CH.

## Migration proposée et retour arrière

Le fichier a été créé avec `supabase migration new` (CLI 2.120.0). Il ajoute deux tables, des contraintes, les fonctions INVOKER à `search_path` vide et les gardes d'historique. La RLS est activée ; les privilèges des rôles PUBLIC, anon et authenticated sont retirés. Seul le service serveur possède les privilèges internes nécessaires. La RLS ne remplace pas l'autorisation du propriétaire D1 : celle-ci est contrôlée par l'API et n'est jamais fournie dans le corps de la demande. Les contraintes et triggers protègent aussi les écritures privilégiées contre une histoire incohérente.

Ces frontières suivent les recommandations [RLS et privilèges](https://supabase.com/docs/guides/database/postgres/row-level-security) et [fonctions PostgreSQL](https://supabase.com/docs/guides/database/functions), vérifiées pour cette tranche. Le changelog Supabase courant a été lu, y compris l'avis sur PostgreSQL 15.19/17.11 ; cette migration n'introduit aucun index ltree/GiST, chiffrement PGP ancien ou opérateur personnalisé visé par cet avis. Cela ne constitue pas un contrôle de ces objets dans la base de production. [Avis PostgreSQL](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).

Aucun ancien fichier SQL n'est réécrit et aucune donnée n'est copiée ou supprimée. Le plan de retour arrière après utilisation consiste à refermer les flags et à retirer le parcours US tout en conservant le profil et son historique. Ne pas rétablir un repli vers les coordonnées CH. Un retrait des objets n'est envisageable que dans une base de test vide, ou après une revue et une approbation explicites ; aucun script destructif de production n'est exécuté.

## Vérifications

La régression sélectionne 87 fichiers couvrant la compatibilité des comptes, abonnements et transports CH, ainsi que le noyau US. Premier lot : 2 401 tests réussis, aucune assertion échouée, mais une suite arrêtée avant ses six scénarios car sa liste de migrations attendues était devenue incomplète. Cette liste a été corrigée, puis les six scénarios ont réussi. Résultat cumulé : **2 407 réussis, 64 non exécutés, zéro échec restant** ; il ne s’agit pas d’un lot unique entièrement vert. Les tests natifs dépendant de fixtures réelles et le test navigateur explicitement opt-in restent parmi les non exécutés.

Les 169 tests vendeur et bindings, inclus dans ce lot, couvrent rôle, isolation, allowlist, reçus invalides, conflit de révision, reprise après réponse perdue, refus tardifs et privilèges SQL. La preuve est conservée dans `docs/evidence/us-seller-profile-20261008.json` et `.qa/us-seller-profile/`. TypeScript, Oxlint des fichiers concernés, build de production et `git diff --check` réussissent. Le build garde ses avertissements Vinext déjà connus. Les 107 anciens fichiers SQL suivis sont inchangés. Les tests PostgreSQL utilisent PGlite local et des données fictives, sans URL ni clé de production. Cette preuve ne couvre pas deux connexions PostgreSQL simultanées, une session réelle Supabase/PostgREST, la charge commerciale ou une recette physique multi-appareils.

## Terminé, expérimental et suite

Le service vendeur, ses RPC, la frontière HTTP et le raccordement serveur de la facturation sont la portée de cette livraison. L'identité publique saisie n'est pas une vérification légale du vendeur ; ni l'API ni ses droits locaux ne prouvent un abonnement Stripe payé. Les droits D1 et le commit PostgreSQL ne forment pas une transaction distribuée. Les coordonnées peuvent évoluer après leur lecture : la facture conserve le snapshot retenu, et ce lot n'atteste pas qu'il correspond obligatoirement à la toute dernière modification concurrente.

L'UI vendeur, le profil fiscal privé, son fournisseur sandbox, la gestion durable des transactions fiscales/avoirs, les paiements des factures et l'admission Stripe US réelle restent à développer et valider. L'ouverture en production attend aussi l'alignement des sources avec le site publié et la vraie application native, les migrations approuvées et une recette staging Auth/D1/PostgreSQL à deux sessions. Les données suisses et la région Supabase restent en place. Aucune conformité US GAAP ou certification commerciale n'est annoncée.
