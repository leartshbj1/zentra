# Zentra US — ventes, rapports et exports portables

Base locale : `7ae938d526cf09110967fabfd0d67154c5d0728f`. Ce lot prolonge les achats US dans le checkout international isolé. Il ne remplace pas le site commercial publié séparément en version Sites354 et n'applique aucune modification en production. Les offres et tarifs suisses restent hors de ce lot.

## Comportement livré

L'écran partagé US expose les factures persistées, leur taxe enregistrée, les dates de facture/comptabilisation/échéance, le solde exact et l'historique des paiements. Un propriétaire, administrateur ou comptable peut enregistrer un paiement déjà reçu, partiel ou complet, dans une période ouverte. Une confirmation est nécessaire ; modifier le brouillon invalide sa confirmation. Le moteur refuse les montants supérieurs au solde et conserve la reprise exacte d'une commande incertaine. Un membre ou un lecteur consulte les données autorisées sans obtenir des actions financières d'écriture.

Le parcours d'émission utilise un devis accepté et la détermination fiscale du port serveur. Le binding réel conserve `invoiceIssuanceAvailable=false` : une configuration fiscale remplie ne constitue pas un prestataire. Le provider réel est toujours absent ; seul un issuer TEST privé, fictif et explicite permet d'exercer ce parcours dans les tests. Aucun taux américain universel, TVA suisse ou QR-facture CH n'est ajouté.

Cinq rapports existants deviennent consultables avec des critères explicites : trial balance, profit and loss, balance sheet, cash flow et general ledger. Les dates, la méthode comptable, l'entreprise et la révision source sont visibles. Les rapports longs sont paginés par 50 lignes dans l'interface. Sur mobile, des cellules étiquetées affichent les montants sans les cacher hors écran. Un résultat d'une ancienne langue ou révision est masqué dès le rendu ; les lectures en attente sont invalidées.

Les devis, factures, fiches internes de factures fournisseurs et rapports possèdent des exports JSON, HTML imprimable, PDF réel et CSV. Les montants sont des unités mineures exactes puis des décimales formatées, sans conversion financière flottante. Les libellés sont disponibles en français, allemand, italien et anglais américain ; les noms, descriptions et notes saisis par les utilisateurs ne sont pas traduits. Les factures reprennent l'identité historique du vendeur et leur configuration archivée, y compris si le profil vendeur courant manque. La fiche fournisseur demeure une saisie interne et n'est jamais présentée comme l'original reçu.

## Autorisation et limites

Les nouvelles routes GET acceptent seulement le type/identifiant de document ou les critères de rapport, le format et la langue. Elles ne prennent pas de faits financiers, rôle ou identité de vendeur dans le corps de la demande. L'autorité, l'utilisateur attendu, les droits Gestion, la configuration nationale, les flags et le plafond de schéma sont vérifiés. L'autorité est relue après les attentes de génération/hachage, et un plafond v2 fermé pendant la génération bloque un export issu d'un head v2. Cela ne prétend pas rendre D1 et PostgreSQL atomiques.

Le snapshot de sortie est une liste de champs publics validés, reconstruite à partir du livre durable. Il exclut EIN, preuves fiscales brutes, secrets et identifiants privés d'acteurs. Les totaux, soldes et soldes intermédiaires du grand livre sont revérifiés. Les exports ne changent pas de numéro, journal, reçu ou événement de synchronisation.

Le navigateur vérifie entreprise, devise, langue, sélecteur, révision, type MIME et SHA-256 des octets avant de proposer un fichier. Une session fermée annule immédiatement ses attentes même si le fetch ou la lecture du corps ignore AbortSignal, et révoque ses URL Blob. Les erreurs connues proposent une action contextualisée ; un quota reste une erreur 429, sans simuler une révocation de compte. Les diagnostics serveur contiennent opération, étape, code et statut, sans contenu financier ni exception brute.

Les réponses utilisent no-store, nosniff et no-referrer. L'HTML est échappé, sans scripts ou ressources distantes, avec CSP restrictive ; le CSV protège ses cellules textuelles contre les formules. Les PDF utilisent Letter, répètent les en-têtes et répartissent les longs textes sans troncature silencieuse. Limites explicites : 1 000 lignes, 500 000 caractères sérialisés, 200 pages PDF et 12 MiB par réponse. Les glyphes non disponibles sont refusés avec une erreur explicite et une alternative HTML. Ces fichiers téléchargés ne peuvent pas être révoqués rétroactivement et ne constituent pas un service d'archivage légal immuable.

## Fichiers et migrations

Les listes exactes créées/modifiées et leurs empreintes sont consignées dans `docs/evidence/us-sales-exports-runtime-20261008.json`. Les groupes concernés sont les nouveaux contrats/renderers/bindings d'export, deux routes GET, les transports et builders navigateur, le workbench/rapports, leurs tests et les dépendances PDF/polices.

Aucune migration n'est ajoutée ou réécrite dans cette phase. Les 134 fichiers SQL existants sont comparés à la base Git : 23 migrations Supabase, 88 Drizzle et 23 autres SQL. Le déploiement n'est pas réalisé. Le retour opérationnel consiste à fermer les flags US, sans suppression de livres ou d'historique.

## Dépendances et sécurité

Le lot ajoute `pdf-lib@1.17.1` et `@pdf-lib/fontkit@1.1.1`. Les deux polices Noto Sans sont issues du dépôt officiel à un commit fixe ; les hashes et la licence SIL OFL 1.1 sont conservés et testés. La génération charge des octets locaux compilés dans un module serveur paresseux ; aucune URL, police ou chemin fourni par le client n'est utilisé.

Cinq correctifs transitifs dans leurs versions majeures existantes sont appliqués : fast-uri 3.1.8, ip-address 10.7.1, brace-expansion 1.1.21 et 2.1.7, source-map-js 1.2.2. L'audit de dépendances n'est cependant **pas propre** : `braces@3.0.3` demeure signalé par [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), dans la chaîne Vinext → plugin CommonJS → import dynamique → fast-glob → micromatch. Au contrôle, npm annonce >=3.0.4 comme correctif mais cette version n'est pas publiée dans le registre et l'avis primaire GitHub n'indique aucun correctif. Les deux exceptions d'audit déjà existantes sont inchangées et documentées dans la preuve. Il reste à traiter cette chaîne avant de revendiquer un audit de sécurité propre ; la compilation et les tests ne prouvent pas à eux seuls son absence d'exploitabilité.

## Validation locale

Validation complète du 8 octobre : **3 350 tests passent dans 85 fichiers**, aucun échec et aucun test ignoré, soit 212 tests supplémentaires depuis la base de ce lot. Les cinq parcours navigateur optionnels sont explicitement activés. Les sept nouveaux fichiers de tests couvrent 205 cas : 39 builders/commandes, 31 transport navigateur, un parcours navigateur, deux polices, 41 snapshot/rendering, 72 HTTP et 19 PostgreSQL. Les sept autres ajouts sont les contrôles de page et de quota dans les fichiers existants.

TypeScript global, lint avec analyse de types des 30 fichiers TS/TSX concernés, compilation de production et diff-check terminent avec sortie 0. Les hashes des 38 sources TS/TSX/CSS/JSON/YAML/TTF sont identiques avant/après les tests, puis après la compilation. Les 134 SQL restent identiques aux blobs Git normalisés de la base, sans migration ajoutée. Les octets fixes des polices PDF apparaissent uniquement dans un chunk serveur paresseux de 1 526 800 octets (720 070 gzip), pas dans le JavaScript client ; cela ne mesure pas le coût CPU/mémoire d'un Worker hébergé.

Le parcours ventes exerce trois commits et quatre POST, dont une reprise identique après perte de réponse, les paiements partiels, le refus d'un montant excessif, les cinq rapports et un téléchargement PDF réel. Les 32 vues, 48 contrôles réels du focus par Tab et le défilement horizontal clavier du grand livre sur tablette passent, sans erreur JavaScript. La lecture retenue R10/EN puis passage R11/FR ne rend pas l'ancien rapport. Ces preuves ne sont pas des essais sur iPhone ou Mac physiques.

Le détecteur visuel mécanique a été exécuté une fois : 23 constats, dont 22 conseils et un avertissement. L'avertissement vise la bordure neutre du message de limitation déjà présente à la base. Les couleurs signalées sont les fallback des variables ac, dont les valeurs réelles clair/sombre viennent de `app/apple-account.css` ; les tailles des métadonnées et le rayon de table sont des choix de l'interface de travail. La recette visuelle bornée a contrôlé les rendus, sans annoncer une certification automatique du design. La compilation conserve les diagnostics existants de middleware déprécié, temps de plugins et classification statique incomplète des routes ; les harness navigateur signalent également des chunks au-dessus du seuil conseillé de 500 kB.

Les résultats définitifs, listes de fichiers, empreintes et preuves sont consignés dans le JSON associé. Les journaux détaillés restent dans `.qa/us-sales-exports`, `.qa/us-sales-browser` et `.qa/us-exports`, hors publication.

La recette exerce les vrais composants React, handlers HTTP, commandes/deltas ERP et générateurs de fichiers avec Auth et CAS RAM synthétiques. PostgreSQL/PGlite utilise 13 migrations réelles et les RPC service_role, sur une connexion RAM sérialisée ; il ne représente pas deux connexions concurrentes hébergées. Les six PDF de recette totalisent onze pages, analysées indépendamment avec pypdf/pdfplumber puis rendues avec Poppler pour contrôle visuel, dont un document avec mot très long et six pages de notes. Les vues couvrent quatre langues, deux thèmes, 320/390/1 280 px, 200 % de texte et le focus clavier.

## Reste à faire et statut

Terminés dans ce lot : consultation des ventes, paiements enregistrés, consultation des cinq rapports et exports portables autorisés. Expérimental : ERP US, émission TEST et rapports internes. Absents de cette preuve : provider fiscal réel, Stripe/ACH bancaire, nouveaux prix USD, durabilité après crash, staging/PostgREST/Auth réels, charge, synchronisation physique multi-appareils, distribution native ou certification comptable.

La suite doit consolider la chaîne de dépendances, le staging avec données fictives, les prochains modules ventes/projets et Support/Automation US, puis l'alignement natif. Les traitements réglementaires restent fermés jusqu'à validation du prestataire, des règles pertinentes et du professionnel compétent. Aucune certification US GAAP, conformité légale complète ou activation commerciale US n'est annoncée.

Références techniques utilisées : [PDF-lib, métriques et couverture des polices](https://pdf-lib.js.org/docs/api/classes/pdffont), [source officielle Noto](https://github.com/notofonts/noto-fonts/tree/ffebf8c1ee449e544955a7e813c54f9b73848eac), [licence Noto OFL](https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/LICENSE). Les hypothèses fiscales/comptables et les sources juridiques restent dans la matrice réglementaire et les phases antérieures ; ce lot n'invente aucune règle fiscale.
