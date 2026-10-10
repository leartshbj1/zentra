# H3a — Classification explicite des messages Support US

Base locale : `9c8013e`. Le précédent jalon H2b apporte un import explicite d'originaux ; il ne classe pas les messages. L'objectif ERP US complet reste actif.

## Architecture retenue avant développement

- Réutiliser les questions nationales indépendantes `triageQuestions` / `parseDecision` et le transport serveur TypeSafe. Ne pas appeler le service Support legacy : ses autorités et effets sont liés aux tables CH, au routage et à Automation.
- Conserver l'autorité H1 fraîche Gestion + Support sur la même période US/USD, avec propriétaire/administrateur pour lire et analyser la boîte. La classification Support ne donne aucun droit Automation, financier ou d'envoi.
- Commande exacte : identifiant idempotent, connexion/révision, UID/version observée et consentement à une version de traitement explicite. Aucun corps, destinataire ou quota fourni par le navigateur.
- Lire le corps côté serveur à origine fixe, corroborer l'UID réellement retourné et la version ; conserver des empreintes des faits bornés, pas le corps ni les secrets dans D1/logs. Les pièces jointes ne sont pas analysées par ce parcours texte.
- Réserver un budget distinct `support_message_classify`, configuré explicitement côté serveur par catalogue/Price ID US. Aucun quota CHF, taux de précision ou prix n'est déduit. Le mois UTC / entreprise / environnement demeure la clé de budget ; changer de formule ou de connexion ne remet pas la consommation à zéro.
- Registre D1 additif : sources, requêtes, dispatch unique et résultat immuable. Réserver avant appel, clôturer le dispatch avant une seule émission sans retry fournisseur. Un résultat réseau incertain reste consommé ; un rejeu exact ne provoque pas un deuxième appel.
- Lire une confirmation historique sous les droits H1 actuels avant de consulter la connexion, la clé ou la politique actuelles. Les nouvelles analyses exigent tous ces contrôles. La perte d'accès purge l'interface.
- Présenter catégorie, priorité, langue et raisons de vérification traduites. Une faible confiance, demande d'humain, catégorie indéterminée, pièce jointe non lue ou corps incomplet empêche toute prétention de traitement autonome.

## Limites et suite

H3a ne route, n'acquitte, ne répond, ne supprime, ne crée de fournisseur/facture/événement et ne comptabilise rien. Les délégations worker révocables, les règles d'affectation, les corrections humaines durables et les workflows client/rendez-vous suivent. L'analyse générale ne réutilise pas le quota `supplier_invoice_extract` ni son autorité financière.

La gate dédiée reste fermée par défaut. Aucun appel fournisseur réel, donnée cliente, migration hébergée, activation ou publication n'est autorisé dans ce jalon local. Les migrations doivent être générées avec l'outil courant, testées localement, inventoriées et soumises à la validation hébergée demandée. Rollback applicatif : fermer la gate ; conserver les reçus.

## Documentation consultée le 10 octobre 2026

- [TypeSafe API](https://docs.typesafe.ai/api) : questions structurées, réponses fermées, modèle explicite.
- [Confiance](https://docs.typesafe.ai/confidence) et [routage conditionné](https://docs.typesafe.ai/patterns/confidence-routing) : la confiance n'est pas une autorisation d'action et ne remplace pas une évaluation réelle.
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) : conserver les contrôles Auth et l'isolation ; aucune nouvelle exposition PG n'est prévue.

La CLI Stripe Directory n'est pas disponible. Sa page publique a été interrogée mais l'outil web n'en a pas extrait le Markdown ; aucun fournisseur nouveau, compte ou abonnement n'est créé. Les références TypeSafe sont ses documents officiels, pas une validation contractuelle de notre compte.

## Recette attendue

Contrats stricts, source anglaise/française, injection, UTF-8/tailles, UID/version/contenu modifié, schéma fournisseur et modèle épinglé, budget concurrent, doublons inter-acteurs/reconnexion, réponses perdues avant/après dispatch, replay après déconnexion, révocation pendant attente, deux entreprises d'un propriétaire, états réservés/incertains, absence d'effets financiers/mail. UI FR/EN/DE/IT, clair/sombre, mobile ; TypeScript, lint et build. La simulation ne prouve ni précision réelle, ni débit hébergé, ni conformité juridique générale.
