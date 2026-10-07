# Zentra — test du marché US

## Périmètre et architecture vérifiée

Ajout isolé à Zentra dans le checkout `chantier` : React 19, Vinext/App Router, Vite, TypeScript, Cloudflare Workers, client REST Supabase serveur déjà existant. Les composants `BrandWordmark`, `BrandMark`, `Button`, `Dialog`, `Input` et `Textarea` sont réutilisés. Aucun paquet n'a été ajouté au projet. Le header/footer US utilisent ces primitives et leurs propres textes ; les composants suisses gardent leurs comportements.

Le checkout initial `chantier` contient Management dans `desktop/`, notamment clients, projets, documents, devis, commandes, factures, fournisseurs et accès équipe. L'import fournisseur `SupplierEmailIntake.tsx`, `supplierEmail.ts` et `supplier_email.rs` prépare des données depuis un message local ; la validation vérifiée limite actuellement l'import au CHF et indique `aiUsed: false`. Les routes web Support/Automation mentionnées dans d'autres travaux ne sont pas présentes dans ce checkout initial. Il serait incorrect de certifier leur disponibilité à partir de cet arbre.

Pour la publication, ces ajouts sont intégrés à la source effectivement publiée (version 348, commit `82871714b1b56eb17eb43b4f1351959d8be880ff`), plus récente que le checkout initial. Cette source contient Support, Automation et les langues du site suisse ; elle est conservée. Les scénarios US restent des aperçus explicitement simulés, sans connecter les données métier suisses. L'adapter de traduction exclut uniquement `app/us/` et `components/us/`. Le layout fixe `en-US` et masque le sélecteur suisse uniquement sur les routes US ; toutes les autres routes gardent leur comportement et le sitemap conserve ses variantes suisses.

La page US propose donc le positionnement demandé, en distinguant explicitement la fondation de gestion existante et les workflows proposés pour le pilote. Aucun calcul fiscal américain, connecteur de boîte mail, traitement IA ou enregistrement métier n'est ajouté à l'application.

## Positionnement US et offre du pilote

La version américaine est annoncée comme **coming soon**. Management dispose d'une section complète avec vocabulaire US : customer management, estimates, sales orders, invoicing, projects/jobs, vendors, purchase orders et team collaboration. Le parcours Customer → Estimate → Project → Invoice est illustratif ; la disponibilité US est confirmée avant l'accès. Les scénarios clients emploient `estimate`, et non une traduction européenne de devis.

Offre explicitement décidée par le propriétaire : **1 month free. No credit card. No commitment.** Elle figure dans le hero, le pilote, le formulaire, sa confirmation, la FAQ et l'aperçu social. Le mois gratuit commence à l'activation de l'accès US, pas à la candidature. Aucune date de lancement n'est inventée. Les demandes sont revues pour leur adéquation au pilote. Il n'y a ni renouvellement automatique ni débit ; continuer après le mois exige un choix explicite d'un abonnement payant, dont le prix n'est pas encore annoncé.

`lib/markets/us.ts` conserve l'identifiant `us-pilot-free-month-v1` et les conditions de cette offre. Le serveur force cette version dans `us_pilot_leads.offer_version` : un visiteur ne peut pas inventer une autre offre. Migration additive `20261007173315_us_pilot_free_month_offer.sql`, appliquée à Zentra Zurich. Les anciennes candidatures ne sont pas rétroactivement associées à l'offre.

L'ouverture du pilote reste une opération de l'équipe : vérifier les fonctionnalités US réellement disponibles, confirmer l'invitation, fournir un accès valide sans paiement et faire courir **un mois calendaire** à partir de cette activation. La candidature seule ne provisionne ni compte, ni licence, ni essai actif. Aucun flux Stripe ou droit d'accès suisse n'a été changé. Avant d'activer le premier participant, l'équipe doit disposer de ce parcours d'accès US et de dates de début/fin enregistrées dans son suivi ; la landing n'est pas un mécanisme automatique de licence gratuite.

## Routes

- `/us` : landing anglaise, hero email → dossier, démos facture/demande/rendez-vous, contrôle humain, présentation de l'écosystème, comparaison avant/après et candidature.
- `/us/privacy` : notice de collecte et de mesure en anglais.
- `POST /api/us-pilot/leads` : validation serveur et enregistrement de candidature.
- `POST /api/us-pilot/events` : collecte des interactions autorisées, sans données du formulaire.
- `/us/og.png` : aperçu social 1200 × 630, produit par HTML natif et le wordmark existant.

Les pages sont ajoutées au sitemap. Title, description, canonical et OpenGraph utilisent la configuration de domaine existante (`PUBLIC_SITE_URL=https://zentraapp.ch`). Le document et le contenu visible portent `lang="en-US"` dès le rendu serveur sur les routes US ; la landing synchronise aussi la langue après hydratation et restaure la précédente à sa sortie. La configuration de marché et les exemples sont dans `lib/markets/us.ts`. La devise USD y sert uniquement à l'exemple, indépendamment des règles fiscales du produit.

## Réel et simulation

**Réel :** formulaire, validation, persistance Supabase, anti-abus, statuts de candidature, UTM, collecte analytics et conversion serveur. Le visiteur ne reçoit de confirmation qu'après une sauvegarde réussie ou la reconnaissance d'une tentative idempotente déjà sauvegardée.

**Simulation :** les trois démonstrations utilisent des données fixes. Elles n'envoient aucun message, ne consultent aucune boîte mail, n'exécutent aucun modèle et ne créent ni facture, ni demande, ni événement dans Management. Elles portent le libellé `Pilot workflow preview` et une explication visible. Le mode `pilot-preview` est explicite dans la configuration. L'exemple de taxe est une donnée du message fictif, pas un calcul fiscal US. Le calendrier est un brouillon proposé avec un fuseau horaire explicite.

Les transitions ont une durée de lecture d'environ 12 secondes, peuvent être interrompues puis reprises au même stade, s'arrêtent hors écran et lorsque l'onglet est caché. `prefers-reduced-motion` affiche immédiatement l'état complet. Les interactions restent utilisables au clavier. Les textes SEO principaux restent exactement ceux demandés ; les textes OpenGraph/Twitter précisent le pilote et ses exemples proposés.

## Données et sécurité

Migration `supabase/migrations/20261007165615_us_pilot_market_test.sql`, créée avec Supabase CLI puis alignée sur la version réellement appliquée par Supabase. Appliquée le 7 octobre 2026 au projet existant **Zentra Zurich**, référence `xvfohjdlhlirksrvkiqu`.

Tables ajoutées :

- `us_pilot_leads` : champs demandés, `submission_id` unique pour les nouvelles tentatives, `status` par défaut `new` ; valeurs autorisées : `new`, `contacted`, `demo_booked`, `pilot`, `converted`, `rejected`.
- `us_pilot_events` : événement, ID idempotent, identifiant anonyme de session, page, UTM, propriétés autorisées et date.
- `us_pilot_rate_limits` : empreinte d'IP/scope, compteur et expiration.

RLS activée. Tous les droits sont retirés à `PUBLIC`, `anon` et `authenticated`. Seul `service_role` accède à ces tables. Un visiteur public crée sa candidature via l'API Zentra ; une politique d'insertion directe anonyme permettrait de contourner l'anti-spam, elle n'est donc pas accordée. Aucune route GET/export des leads n'est exposée. Le suivi se fait dans Supabase avec un compte administrateur autorisé.

Protection : origine exacte, refus des requêtes cross-site, JSON limité à 12 ko pour les candidatures / 2,5 ko pour les événements, champs et longueurs validés côté client/serveur/base, honeypot, fenêtre de remplissage de 1,5 seconde à 24 heures, limite atomique de 5 candidatures/heure/IP et 240 événements/heure/IP. Le runtime Cloudflare écrase `CF-Connecting-IP`; `X-Forwarded-For` n'est pas utilisé. Sur un autre hébergement, revoir ce contrat de proxy avant déploiement.

Le RPC de limitation est `SECURITY INVOKER`, avec recherche de schéma verrouillée et exécution réservée au serveur. Les empreintes expirées sont purgées lors des requêtes suivantes. Les valeurs sensibles, les erreurs détaillées de Supabase et les réponses au formulaire ne sont ni renvoyées au navigateur ni journalisées par ces nouveaux services.

## Analytics et lecture des résultats

L'adapter `lib/us-pilot/analytics.ts` peut recevoir un provider via `setPilotAnalyticsProvider`; le provider par défaut appelle l'API interne. Il n'existe pas de provider analytics déjà utilisé dans ce checkout. La session et les UTM sont conservés dans `sessionStorage` avec un repli en mémoire. Le tracking facultatif respecte Do Not Track et Global Privacy Control.

Événements :

| Événement | Déclencheur |
| --- | --- |
| `page_view` | Hydratation de `/us`, une fois par montage |
| `watch_demo` | Clic explicite sur regarder, lecture/relecture ou choix d'un workflow |
| `demo_completed` | Fin d'une lecture, ou affichage statique demandé en reduced-motion |
| `pilot_cta_clicked` | Clic sur une entrée de candidature, avec son emplacement |
| `pilot_form_started` | Premier changement d'un champ |
| `pilot_form_submitted` | Sauvegarde confirmée côté serveur ; ID de soumission unique |

Les événements de démo distinguent `manual`, `autoplay` et `reduced_motion`. Une animation automatique terminée ne constitue pas une preuve d'intérêt volontaire. Le mode statique ne mesure pas du temps d'attention. Les données analytics sont indicatives : bloqueurs, opt-out, bots et changements de session affectent les volumes. Le nombre de leads sauvegardés reste la référence même si l'insertion analytics échoue. Aucun événement n'est une preuve que l'entreprise se trouve aux USA ; les campagnes et la candidature produisent une intention déclarée, à qualifier lors du contact.

Requêtes de lecture, à exécuter uniquement dans Supabase SQL Editor avec accès autorisé :

```sql
-- Répartition des interactions et sessions observées.
select event_name, count(*) as events, count(distinct visitor_id) as sessions
from public.us_pilot_events
where created_at >= now() - interval '30 days'
group by event_name order by event_name;

-- Engagement volontaire avec les démonstrations.
select properties->>'workflow' as workflow, event_name,
       count(distinct visitor_id) as sessions
from public.us_pilot_events
where event_name in ('watch_demo','demo_completed')
  and properties->>'mode' = 'manual'
group by workflow,event_name;

-- Candidatures réelles et intérêt pour une démo par campagne.
select utm_source,utm_medium,utm_campaign,count(*) as applications,
       count(*) filter (where demo_interest) as open_to_demo
from public.us_pilot_leads group by utm_source,utm_medium,utm_campaign;

-- Qualification commerciale : le compteur de candidatures seul ne suffit pas.
select employee_count,status,count(*) as businesses
from public.us_pilot_leads group by employee_count,status;
```

Qualifier les tâches répétitives, les outils actuels, les démos acceptées et les passages effectifs à `pilot`/`converted`. Les faux compteurs, témoignages, logos et résultats commerciaux sont absents. La page ne propose ni abonnement ni tarif US.

## Configuration

Réutiliser les variables serveur existantes : `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (ou `SUPABASE_SERVICE_ROLE_KEY` pour compatibilité), `PUBLIC_SITE_URL`. La clé publique existante reste utilisée pour Auth uniquement. Aucune variable `NEXT_PUBLIC_` ne doit contenir de clé privée. Aucun nouveau service payant ou clé analytics n'est nécessaire. `.env.supabase.example` documente la clé de persistance serveur ; les secrets de production ne sont pas copiés localement.

## Validation

Résultats du 7 octobre 2026 :

La révision de l'offre et de Management repasse ces contrôles : 62 tests, contrat Supabase, lint et typecheck, build final `build-offer-final.log`, quatre viewports et texte à 200 %. Le navigateur vérifie aussi le message coming soon, les six bénéfices Management, les conditions avant candidature et après succès, ainsi que la FAQ. Le scénario RLS vérifie désormais la version d'offre par défaut et le refus d'une valeur inventée. Les tests annulés laissent zéro lead/événement. L'aperçu social servi correspond à l'asset final avec provenance. Une vérification des 1 277 fichiers source préexistants confirme que seules les deux modifications communes déjà listées diffèrent de l'état initial.

- 62 tests Vitest pertinents passent : validation, serveur et analytics US, Auth/client/repositories Supabase et lecture des corps HTTP.
- Le contrat Supabase existant passe ses 15 assertions ; le scénario RLS US sur la base réelle retourne `PASS`, puis annule ses données de test.
- `pnpm lint`, le lint ciblé des nouveaux fichiers, le typecheck TypeScript et le build production Vinext passent.
- Contrôle navigateur sur le build production : 1440 × 1000, 390 × 844, 320 × 740 et 820 × 1180, sans débordement horizontal ni erreur runtime. Zoom texte à 200 %, formulaire clavier/Escape, tous les CTA et les trois exemples vérifiés.
- Validation requise et email invalide, échec de sauvegarde, valeurs conservées, même identifiant de nouvelle tentative et confirmation après succès vérifiés. Animation normale : pause/reprise au même stade et fin manuelle ; reduced-motion : résultat statique.
- Les cinq événements navigateur autorisés sont observés ; `pilot_form_submitted` est réservé au serveur et couvert par ses tests. Les UTM sont vérifiés dans les données du formulaire.
- Routes suisses représentatives `/`, `/features`, `/pricing`, `/security`, `/download`, `/demo-facture` et nouvelles routes retournent 200 sur le build. L'API refuse les lectures (405) et les origines étrangères (403).
- Aucun secret Supabase n'est trouvé dans les 50 bundles JavaScript client examinés. Le contrôle des empreintes initiales ne détecte aucun changement de source préexistante hors `app/sitemap.ts` et `.env.supabase.example`.
- Revue Impeccable de la révision US/Management/offre : disposition `ship`, revue complète des cinq sections du contrat, neuf captures valides et aucun correctif matériel demandé. La première revue avait également validé ses quatre corrections.

Les scripts de contrôle sont `scripts/us-pilot-browser-qa.mjs`, `scripts/us-pilot-social.mjs` et `supabase/tests/database/us_pilot_rls.test.sql`. Les captures et résultats temporaires sont dans `.qa/us/`, ignoré par Git. Ces résultats couvrent le périmètre US et des contrôles de non-régression ; ils ne constituent pas une certification de l'ensemble du produit suisse.

Le test navigateur simule uniquement les réponses réseau succès/échec de sauvegarde et de tracking. La route serveur est testée séparément avec un client Supabase contrôlé ; RLS, refus de lecture, insertions, contraintes et limitation sont vérifiés sur la vraie base dans une transaction annulée. Cela ne remplace pas une candidature complète sur la future URL publique.

## Intégration à la source publiée

La publication est préparée depuis la version 348 dans un checkout séparé, en conservant les dernières fonctionnalités suisses. Sur cette source intégrée, 80 tests pertinents passent (dont les 33 tests de langue existants et l'exclusion US), ainsi que TypeScript, le build production, le lint ciblé sur les routes et composants US, le layout et le sitemap. Le lint global de la version publiée possède déjà des erreurs hors US ; les deux erreurs de style préexistantes du plugin de langue ne sont pas modifiées. Le contrôle navigateur du build intégré repasse les quatre viewports, le texte à 200 %, le formulaire et ses erreurs, tous les CTA, les événements et reduced-motion, sans erreur runtime.

La préparation initiale et ses 62 tests ci-dessus portent sur le checkout `chantier`, distinct de cette source publiée. Les changements communs supplémentaires pour l'intégration sont le garde de route US dans `app/layout.tsx`, l'exclusion dans `scripts/site-i18n-plugin.mjs` et sa couverture dans `lib/site-language.test.ts`. Aucun changement aux dépendances, langues suisses, paiements ou licences n'est nécessaire.

## Avant lancement public

Le checkout initial a de nombreuses modifications préexistantes et ne correspond pas à l'ensemble des routes présentes sur le site publié. L'intégration décrite ci-dessus reprend uniquement le périmètre US ; le checkout initial complet n'est pas publié. Le résultat du déploiement et de la candidature de recette sera confirmé séparément après publication.

Après intégration : vérifier le domaine et les clés serveur, envoyer une candidature de recette identifiable sur la vraie URL `/us`, confirmer son enregistrement et les UTM puis vérifier les refus publics. Organiser la revue manuelle et les demandes de suppression ; confirmer la durée de conservation avant une campagne. Au démarrage, utiliser des liens UTM cohérents et suivre surtout les entreprises qualifiées et les démos réellement réalisées. Si le volume ou les bots le justifient, ajouter une protection edge/CAPTCHA et affiner les limites réseau sans ouvrir les tables au public.

## Inventaire

Fichiers créés :

```text
app/us/page.tsx
app/us/us.css
app/us/privacy/page.tsx
app/api/us-pilot/leads/route.ts
app/api/us-pilot/events/route.ts
components/us/landing.tsx
components/us/workflow-demo.tsx
components/us/pilot-form.tsx
lib/markets/us.ts
lib/us-pilot/validation.ts
lib/us-pilot/validation.test.ts
lib/us-pilot/server.ts
lib/us-pilot/server.test.ts
lib/us-pilot/analytics.ts
lib/us-pilot/analytics.test.ts
supabase/migrations/20261007165615_us_pilot_market_test.sql
supabase/migrations/20261007173315_us_pilot_free_month_offer.sql
supabase/tests/database/us_pilot_rls.test.sql
scripts/us-pilot-browser-qa.mjs
scripts/us-pilot-social.mjs
public/us/og.png
docs/US-PILOT.md
docs/US-PILOT-DESIGN.md
.impeccable/surfaces/app-us.md
```

Fichiers existants modifiés dans la préparation initiale : `app/sitemap.ts` et `.env.supabase.example`. Dans la source intégrée, les gardes US ajoutent aussi `app/layout.tsx`, `scripts/site-i18n-plugin.mjs` et `lib/site-language.test.ts`. Les comportements des routes suisses, migrations historiques et données existantes sont conservés. Supabase CLI a également actualisé son cache local de version dans `supabase/.temp/cli-latest` de la préparation initiale.
