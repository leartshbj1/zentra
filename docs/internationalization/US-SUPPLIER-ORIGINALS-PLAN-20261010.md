# Documents fournisseurs US — prochaine verticale

Base `3965ae7`, après le lifecycle SaaS TEST. Le parcours actuel d'analyse US est réellement raccordé à son consentement et budget privés, mais ne reçoit que du texte. Support appelle encore le flux CH historique. Aucun original PDF/image US n'est archivé. Ce plan complète l'audit initial avant modification ; aucun déploiement n'est autorisé implicitement.

## Parcours à construire

Importer un original depuis Gestion, conserver ses octets dans un namespace privé R2, extraire le texte d'un PDF lorsque possible, puis préparer la proposition avec le moteur US existant. La revue humaine et l'enregistrement atomique dans le livre comptable existant restent inchangés. Un fichier sans texte lisible reste conservé avec une indication claire ; aucune transcription ou OCR ne sera inventé.

Les empreintes binaire et texte sont distinctes. `UsSupplierSource.sha256` et le registre d'analyse restent liés au texte UTF-8 ; une relation séparée rapproche ce texte de l'original. Le PDF n'est jamais renommé en preuve fiscale extraite. Le nom/auteur/date du premier import restent conservés. Les résultats incertains reprennent le même identifiant et les mêmes octets, sans second document ni seconde analyse.

## Architecture additive

- Contrat document privé/public, registre PostgreSQL d'originaux immuables, reçus de stockage et liens vers propositions, avec RLS et RPC serveur uniquement.
- R2 via le binding existant `FILES`, préfixe distinct US/entreprise/id/empreinte, `put` conditionnel, relecture et vérification SHA256 avant reçu. Aucun URL public ni clé d'objet fourni au navigateur. Pas de suppression/GC dans cette phase : aucun lease/génération de nettoyage à réutiliser prématurément.
- API par entreprise : liste, import binaire borné, lecture privée de l'original et préparation de l'analyse liée au document. Auth, rôle financier, Gestion, pays/devise/capacité et gates revalidés autour des attentes. L'analyse exige en plus Automation, son consentement et son quota existants.
- Interface opératoire sobre dans Achats, traduite dans les quatre langues existantes, claire/sombre et mobile. Aucune donnée privée en localStorage ; brouillons et octets en mémoire purgés lors de changement d'identité/espace.

Deux originaux différents produisant le même texte ne doivent pas être adoptés silencieusement comme la même pièce financière. Les replays d'une même empreinte binaire conservent l'identité ; les collisions de provenance d'une proposition exigent une revue. Ni service_role, ni signature de fichier, ni modèle ne constitue une permission métier.

## Vérification et limites

Tester chaîne SQL complète, grants/RLS, CH préservé, immutabilité, limites, déduplication et reprise, R2 corrompu/missing/réponse perdue/écriture concurrente, invalidation Auth/droits, source étrangère, PDF réel et document sans texte, original→analyse fictive→revue→facture/journal unique. Vérifier navigateur mobile/desktop en quatre langues, puis TypeScript/lint/build.

L'IRS demande des justificatifs du revenu et des dépenses et une reproduction lisible des pièces électroniques ; cette archive locale proposée ne prouve ni conformité complète, ni durée légale unique de rétention, ni restauration hébergée. [Recordkeeping](https://www.irs.gov/businesses/small-businesses-self-employed/recordkeeping), [pièces justificatives](https://www.irs.gov/businesses/small-businesses-self-employed/what-kind-of-records-should-i-keep).

Référence technique : l'API Workers R2 prévoit écritures conditionnelles, checksum SHA256 et lecture des octets. La relecture applicative reste nécessaire à notre contrat. [API R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

Le changelog Supabase a été consulté le 10 octobre : la release PostgreSQL 15.19/17.11 signale des changements pour ltree, pgcrypto, btree_gist et opérateurs personnalisés. Ne pas mettre à niveau ou réparer la production comme effet secondaire ; rapprocher la version du staging. [Changement PostgreSQL](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).

Aucune migration historique réécrite, aucun objet CH réutilisé comme autorité US, aucun bucket ou prestataire nouveau, aucune donnée cliente ni région déplacée. Toute migration/activation de production nécessite l'approbation explicite demandée. Fermer la nouvelle gate arrête ce parcours sans effacer les originaux, reçus, propositions ou écritures. Le raccord automatique de messagerie Support US reste une étape suivante avec délégation propre ; l'archive ne l'annonce pas livré.
