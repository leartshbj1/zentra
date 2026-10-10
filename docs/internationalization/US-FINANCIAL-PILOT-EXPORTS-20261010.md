# Zentra US — exports du pilote financier V5

Date : 10 octobre 2026. Phase incrémentale, lecture seule, TEST privé.

Implémentation locale : `e77c65385c22c098ef3746144b41ca4ab721a116`. Preuve : [us-financial-pilot-exports-20261010.json](../evidence/us-financial-pilot-exports-20261010.json). Plan antérieur : [US-FINANCIAL-PILOT-EXPORTS-PLAN-20261010.md](US-FINANCIAL-PILOT-EXPORTS-PLAN-20261010.md).

## 1. Résumé des modifications

Le pilote navigateur peut télécharger ses factures en PDF et ses rapports en PDF/CSV à partir du même livre V5 courant. Les rapports couvrent balance, résultat, bilan, trésorerie lorsque classifiée, grand livre du compte choisi et créances courantes. Le sélecteur lie chaque fichier à l’entreprise, à la révision, à la langue et aux dates applicables ; les créances courantes ne simulent pas un état historique.

Les quatre montants facturé/reçu/crédité/restant restent distincts. L’exemple exact 107/50/35/22, les historiques de plus de 25 paiements/avoirs et les montants supérieurs à MAX_SAFE_INTEGER sont vérifiés. Les projections reconstruisent le livre complet, sans exporter uniquement la page de 25 lignes de l’interface. Les coordonnées des factures viennent des snapshots historiques. Aucun profil d’entreprise fictif n’est fabriqué pour les rapports lorsqu’un nom n’existe pas dans la configuration.

Les documents PDF utilisent Letter, les formats américains et les fontes Noto Sans embarquées. Les libellés existent en FR/DE/IT/EN ; les données saisies restent intactes. Les tables longues ont des en-têtes/pieds et une pagination explicites. Le CSV conserve les décimaux exacts et protège les cellules textuelles contre l’interprétation comme formule. Limites explicites : 1 000 lignes, 500 000 caractères, 200 pages PDF, 12 MiB ; glyphes non pris en charge refusés.

L’action reste locale au bouton : préparation, fichier prêt ou erreur contextualisée, sans remplacer la facture et son brouillon d’encaissement. Un changement de compte, entreprise, révision, document ou plage invalide le téléchargement en cours. L’erreur de limite sur une facture demande son numéro à l’assistance ; celle d’un rapport propose de réduire la période.

## 2. Fichiers créés

- `app/api/international/workspaces/[organizationId]/financial-pilot/exports/invoices/[invoiceId]/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/exports/reports/[kind]/route.ts`
- `components/account/us-financial-pilot-export-actions.tsx`
- `lib/international/browser-us-financial-pilot-export-copy.ts`
- `lib/international/browser-us-financial-pilot-export-session.test.ts`
- `lib/international/browser-us-financial-pilot-export-session.ts`
- `lib/international/us-financial-pilot-export-bindings.test.ts`
- `lib/international/us-financial-pilot-export-bindings.ts`
- `lib/international/us-financial-pilot-export-contract.test.ts`
- `lib/international/us-financial-pilot-export-contract.ts`
- `lib/international/us-financial-pilot-export-copy.ts`
- `lib/international/us-financial-pilot-export-projection.test.ts`
- `lib/international/us-financial-pilot-export-projection.ts`
- `lib/international/us-financial-pilot-export-renderer.test.ts`
- `lib/international/us-financial-pilot-export-renderer.ts`
- `lib/international/us-financial-pilot-export-server.test.ts`
- `lib/international/us-financial-pilot-export-server.ts`
- `lib/international/us-financial-pilot-exports.postgres.test.ts`

## 3. Fichiers modifiés

- `.impeccable/surfaces/financial-pilot.md`
- `components/account/us-financial-pilot.css`
- `components/account/us-financial-pilot.tsx`

Aucun ancien module suisse, abonnement, identifiant Stripe, dépendance ou historique de migration n’est modifié. Le brief conserve l’autorité visuelle existante ; les documents globaux de design restent inchangés.

## 4. Migrations proposées et retour arrière

**Aucune nouvelle migration.** Les exports réutilisent les 32 migrations existantes, l’opt-in, les grants privés, l’admission et les lecteurs V5 du pilote. Aucun provisioning, écriture d’export, Storage, reçu, événement, commit, envoi d’e-mail ou prestataire fiscal n’est ajouté.

L’accès nécessite les contrôles TEST existants, l’espace US/USD/accrual, les droits effectifs et un rôle owner/admin/accountant. Les GET exigent le scope du pilote, l’utilisateur attendu et une provenance same-origin ; les credentials natifs sont refusés. Auth/D1, configuration, flags, scope/grant/opt-in et révision sont revérifiés autour des attentes. La revue croisée a renforcé le dernier contrôle de flag après l’attente d’autorité et la neutralisation des exceptions privées.

Les réponses portent MIME, longueur, identifiants de scope, révisions et hashes du sélecteur et des octets, avec no-store/nosniff. Le client borne le flux et son délai, vérifie ces preuves, invalide les réponses tardives et révoque les URL Blob. Aucun token n’est conservé pour les exports.

Pour fermer cette lecture, désactiver le pilote selon sa procédure existante, sans supprimer l’historique, les grants versionnés ou le marqueur d’installation V5 d’une entreprise promue. Ne jamais revenir silencieusement à la baseline ERP4. Aucune modification de production n’a été exécutée.

## 5. Tests exécutés et résultats

Résultats réellement observés sur les mêmes sources figées :

| Contrôle | Résultat |
| --- | --- |
| Régression finale | **5'652 / 5'652 tests dans 168 fichiers**, zéro échec/skip/todo ; 161 fichiers précédents conservés, 7 nouveaux. |
| Contrat et projection | 34 tests, inclus dans le total final. |
| Serveur et bindings | 83 tests, inclus. |
| Rendu PDF/CSV | 37 tests, inclus. |
| Transport navigateur et copie d’erreur | 53 tests, inclus. |
| Recette PostgreSQL exports | 11 tests, inclus. |
| TypeScript global non incrémental | Sortie 0. |
| Lint typé des 19 fichiers TS/TSX | Sortie 0, deny-warnings. |
| Vérification de marque et build production | Sorties 0 et 0 ; aucun déploiement. |

Les commandes exactes, durées, résultats par fichier et hashes des artefacts figurent dans la preuve. Les contrôles avant/après ont conservé l’arbre de **3518 fichiers**, SHA-256 `efe904ac46ab8cd3f4fbc7e6e389c4ae7f3f0e8b2d3076b74d2b3b4c93601e6b`. Le recorder a terminé avec sortie 0 après commit, vérifiant les octets réellement testés et les blobs Git. Il respecte le réglage autocrlf existant et distingue explicitement les octets de checkout LF/CRLF ; aucune configuration Git n’a été modifiée.

Les preuves ciblées initiales et tentatives échouées sont conservées séparément ; elles ne s’ajoutent pas au total de la régression finale. Le premier TypeScript intermédiaire avait signalé des types ArrayBuffer/mocks et des initialisations dans les nouveaux fichiers ; ils ont été corrigés avant le gel. Les premières recettes PostgreSQL comportaient des limites/délais/assertions de fixture incorrects ; elles ont été corrigées, sans inventer de validation sur les octets précédents. Voir les rapports historisés et la preuve finale.

La recette SQL utilise les 32 migrations réelles dans PGlite et les handlers Request/Response réels avec Auth/D1 synthétiques. Elle comprend 26 paiements, achats/avoirs/journaux/contrepassation/périodes, une nouvelle facture V5, révocations pendant rendu et changement réel du head pendant export. Les registres privés et le curseur ne changent pas du fait d’un export. Une fermeture/réouverture NodeFS propre a été exécutée. Ce n’est pas une preuve de PostgreSQL multiconnexion, de crash, de charge, d’Auth hébergée ou de prestataire fiscal.

La revue indépendante conclut **ship** pour les seuls contrôles d’export : 27 PNG réellement validés et inspectés, quatre langues, deux thèmes, ordinateur et mobile, dont allemand à 320 px. Les PNG sont des conversions des captures JPEG CUA avec RGB décodé identique ; les sources et empreintes sont conservées. Préparation, succès et erreur conservent le brouillon 7.50. Le refus d’accès visuel vient du polling existant ; les tests de transport vérifient séparément le refus d’export. Le détecteur exécuté une fois donne zéro finding principal et six avis hérités de typographie/rayon, sans correction globale hors périmètre. La documentation visuelle a été finalisée par un agent distinct.

Huit PDF fictifs figés sont analysés et inspectés sur 23 rasters de première/suite/dernière page, dont facture de 7 pages, grand livre de 4 pages et balance de 2 pages. Aucun débordement/glyphe manquant observé dans les sorties finales inspectées. Les totaux débit/crédit restent ensemble. Les vrais téléchargements navigateur de facture PDF de 24 662 octets et créances CSV de 1 093 octets sont conservés avec SHA256. Le harnais visuel utilise le kernel mémoire V5, pas la base PGlite de la recette SQL. L’onglet et le serveur de recette créés pour ces contrôles ont été fermés, et le viewport réinitialisé.

## 6. Risques identifiés

Les fences Auth/D1 et PostgreSQL restent distinctes : ces contrôles successifs ne forment pas une transaction distribuée et ne garantissent pas une absence de révocation après le dernier check. Le rendu embarqué a un coût CPU/mémoire ; les délais bornent les attentes, sans promettre d’interrompre une instruction JavaScript synchrone. Aucun SLA n’est déduit du temps des tests locaux. Les budgets refusent les documents excessifs et les glyphes non couverts plutôt que produire un fichier incomplet.

Le nom de l’émetteur d’un rapport peut rester absent faute de donnée autorisée ; cela est explicite et aucun nom arbitraire ne le remplace. Les rapports ne sont ni certifiés US GAAP ni déclarations fiscales. La trésorerie non classifiée reste bloquée. Les observations de taxe restent test_fixture ; adjustment_pending n’est pas une correction réalisée chez un prestataire.

Un défaut adjacent non bloquant est conservé : le montant $300.00 de la ligne de résultat non clôturé peut se répartir sur deux lignes en allemand à 320 px. Les nouveaux contrôles ne débordent pas. Les avertissements de bundles supérieurs à 500 kB du build sont à mesurer avant hébergement. Aucun passage Windows/macOS/iOS/Android ou distribution native n’est validé par ce lot web.

## 7. Fonctionnalités terminées

Exports en lecture seule du pilote V5, snapshots stricts et complets, factures PDF, six familles de rapports PDF/CSV selon disponibilité, quatre langues, contrôles navigateur de portée/intégrité/délai, protection des informations privées, récupération locale contextualisée et preuves SQL/rendu/UI sur sources figées. Les fichiers sont calculés sur demande, jamais archivés ou envoyés automatiquement.

## 8. Expérimental et prochaine phase

Le pilote reste privé TEST, fermé par défaut. Les écritures navigateur hors encaissement, le provisioning, l’admission hébergée/native, la fiscalité et les paiements marchands réels, l’archivage/envoi et la validation professionnelle restent ouverts. L’objectif ERP US complet demeure actif.

Prochaine verticale minimale : créer un client, créer/modifier son devis puis l’accepter depuis le navigateur. Les formulaires, DTO publics et transports de ces commandes sont absents aujourd’hui ; le moteur V5, les commandes commerciales, le CAS et les reçus SQL peuvent être réutilisés. L’émission fiscale et le PDF du devis restent des raccords distincts.

Conserver TEST, grants/opt-in versionnés, Auth/D1 frais, permissions actuelles, requestId et révisions attendues. Dériver les clés côté serveur et reprendre exactement la même demande en cas de résultat inconnu ; ne pas ouvrir le dispatcher natif ou une activation hébergée.

Acceptations prévues avant cette écriture :

1. Vrai HTTP → PostgreSQL : client → devis → acceptation, numérotation correcte et journal financier inchangé.
2. Deux sessions retrouvent les mêmes données ; une modification concurrente impose 409 et une revue explicite.
3. Réponse perdue après commit : reprise identique sans doublon ; requestId réutilisé avec un autre contenu refusé.
4. Devis lié à une commande active protégé selon PO008, reprise historique encore lisible.
5. Révocation d’identité/rôle/plan/grant/flag pendant attente, isolation interentreprises et récupération claire dans les quatre langues.

Ces scénarios sont un plan, pas des tests déjà exécutés de la future verticale. Aucune migration ni modification de production n’est autorisée implicitement par ce jalon.
