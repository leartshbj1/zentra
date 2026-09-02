# Benchmark fonctionnel Bexio → Zentra

État de la recherche : 2 septembre 2026. Sources Bexio officielles uniquement. La colonne Zentra décrit la source 1.19.0.

Ce document sert de référence produit. Il ne s'agit ni de copier l'interface de
Bexio, ni de promettre des services qui exigent une certification ou un
partenaire bancaire. Zentra conserve son différenciateur : une véritable
application locale Windows et macOS dont la base métier active reste chez le
client. Seuls le compte, les droits et l’archivage volontaire des PDF de
factures utilisent le service Zentra.

## Ce qui fait réellement la valeur de Bexio

La valeur principale n'est pas une longue liste de menus. C'est la continuité
sans ressaisie entre un contact, un devis, une commande, une livraison, une
facture, son paiement, puis l'écriture comptable. Les écrans Zentra doivent donc
présenter une prochaine action claire et garder chaque transformation traçable.

## Matrice de couverture

| Domaine | Référence Bexio vérifiée | Zentra 1.19.0 source | Écart utile à combler | Priorité |
| --- | --- | --- | --- | --- |
| CRM | contacts, catégories, interlocuteurs, historique documentaire, import/export | clients et vue 360 | import prévisualisé, catégories, rappels et pièces liées | P1 |
| Vente | devis → commande → livraison → facture, QR, avoirs, modèles, récurrence, relances | devis avec produits → commande, BL partiel/complet et situation/finale par quantités ; prestation simple → facture directe ou modèle récurrent supervisé ; PDF A4 natifs devis/factures, QR vectoriel, avoirs et relances locales ; identité, logo et montants figés sur les documents émis | acomptes par montant/pourcentage, modèles FR/DE/IT et envoi configuré | P0 |
| Achats | boîte de réception, facture/avoir fournisseur, commande et réception | commande fournisseur → réception partielle/complète → facture → rapprochement multi-commandes → paiement et comptabilité ; import local déterministe d'un e-mail `.eml`/`.txt` en brouillon contrôlé, doublons et pièces signalés ; tolérance globale et avoir distinct | connexion facultative à une boîte mail et lecture du contenu PDF joint | P1 |
| Banque | connexion directe, ISO 20022, paiements, rapprochement débiteurs/créditeurs | CAMT.053/.054 local et confirmation humaine | pain.001 contrôlé, règles explicables puis connexions optionnelles | P1 |
| Comptabilité | débiteurs/créditeurs automatiques, journal, grand livre, bilan, résultat, TVA | partie double, rapports, profils TVA versionnés, paiement client relié à une écriture active, aperçu du décompte et XML eCH-0217 v2.0.0 local ; clôture cumulative scellant toute date ≤ dernière clôture, replays strictement identiques permis, corrections postérieures référencées et dossier fiduciaire DRAFT/FINAL | pièces sur toutes les écritures et automatisations de révision avec la fiduciaire | P1 |
| Projets | étapes, tâches, responsables, temps, budget, dépenses et facturation | projets/chantiers, jalons, tâches, responsables, échéances, agenda jour/semaine/mois, rendez-vous locaux, temps, coûts, rentabilité et temps → facture | tarifs multiples et dépenses remboursables facturables | P1 |
| Catalogue/stock | produits/services, seuils, commandes, réservations, réceptions | catalogue, registre immuable, réservation de vente, sortie sur BL et entrée uniquement à l'émission d'une réception fournisseur ; l'extourne de réception crée le mouvement inverse | emplacements et inventaires guidés | P1 |
| Paie | paie complète, barèmes source, assurances, Swissdec/ELM, certificats | moteur local versionné, PDF A4 professionnel, écritures et analyse SmolVLM générique locale multipage ; manifeste d'audit v2 et validation humaine ; contrôles LPP 2026, AAP/AANP/CAF et cumul LAA dérivé ; salaires minimes 1.18 avec seuil ordinaire CHF 2'500, exception ménage jeune CHF 750, secteurs obligatoires, demande prospective, rattrapage et trace locale probante | QST autonome, LPP multiannuelle complète, IJM structurée, Swissdec/ELM, certificats annuels et certification externe | P0 conformité — en cours |
| Documents | archive Olico, intégrité, recherche et droits | pièces hashées, documents émis figés, sauvegardes, dossier de clôture avec manifeste et coffre PDF optionnel R2/D1 chaîné pendant dix ans ; ce coffre n’est pas revendiqué WORM/Olico | validation indépendante de l’archivage probant et export chiffré | P1 conformité |
| Mobile | contacts, ventes, reçus et temps | site commercial mobile ; application de bureau Windows et macOS | compagnon terrain ciblé avec synchronisation volontaire | P1 |
| Intégrations | API OAuth, Marketplace et Zapier | aucune API métier publique | contrat local versionné après stabilisation du modèle | P2 |
| Sécurité | ISO 27001, 2FA, sauvegardes cloud | SQLite locale, DPAPI sous Windows, Trousseau sous macOS, compte d’entreprise à rôles, révocation des sessions, sauvegardes et updater signé avec parcours de reprise guidé | chiffrement de base optionnel, audit externe, Authenticode et notarisation du DMG | P0/P1 |

## Ordre d'implémentation retenu

1. **Planifier et exécuter — livré en 1.6** : jalons, tâches, responsables,
   échéances et temps rattaché à une tâche.
2. **Vendre sans ressaisie — livré en 1.7** : devis avec produits → commande →
   livraison partielle ou complète → situation/facture finale par quantités,
   sans double mouvement de stock; facture directe conservée pour les services.
3. **Acheter sans ressaisie — livré en 1.8** : commande fournisseur →
   réception partielle ou complète → facture → rapprochement → paiement et
   écriture comptable, avec avoir fournisseur géré et imputé séparément. Les
   réceptions émises sont le seul événement de ce cycle qui entre les articles
   suivis en stock; leur extourne crée la sortie inverse.
4. **Clôturer proprement — livré en 1.9** : méthode TVA versionnée, classement
   explicite des sources, ajustements avec extourne, aperçu contrôlable et XML
   eCH-0217 v2.0.0 généré localement pour import manuel; pré-clôture avec
   empreinte SHA-256, verrouillage en deux étapes et dossier fiduciaire
   DRAFT/FINAL.
5. **Fiabiliser les preuves et la maintenance — livré en 1.10** : texte PDF
   multipage limité aux pages analysées, provenance visible, rattachement paie
   interdit sans page concordante, logo figé sur commandes et BL, reprise de
   paiement revalidant l’écriture, guide complet et updater étape par étape.
6. **Automatiser sous contrôle — récurrence livrée en 1.11** : Zentra prépare
   localement des factures brouillon récurrentes par lots bornés, avec pause,
   reprise, fin et revue obligatoire; l'émission, le QR, l'envoi, le stock et
   la comptabilité restent manuels. L'envoi des relances, l'OCR des achats et
   les règles bancaires contrôlées constituent la suite de ce lot.
7. **Fiabiliser les sorties et la reprise — livré en 1.13 source** : PDF natif
   paginé depuis les instantanés figés, QR-facture vectorielle contrôlée,
   preuve paiement-écriture fail-closed et import de paie multipage dont chaque
   proposition reste locale, traçable et soumise à une confirmation humaine.
8. **Progresser sans inventer les choix — livré en 1.15 source** : création de
   l'espace après l'identité et l'activité essentielles, puis confirmation
   différée des réglages de facturation, de temps/coûts et de sauvegarde ;
   rapprochement fournisseur multi-commandes avec tolérance globale et
   protection des ventilations ; date de paiement utilisée pour les cotisations
   de paie calculées par taux et arrondies au CHF 0.05.
9. **Renforcer les preuves locales — livré en 1.17 source** : logo d'entreprise
   copié dans le stockage géré et référencé par hash sur les documents figés ;
   analyse de paie auditée v2 avec corroboration PDF et rapprochement Unicode ;
   plafond LAA proratisé selon la période d'emploi 30/360 et cumul dérivé de
   l'ouverture annuelle et des fiches antérieures ; paiement
   client daté, borné au solde d'une facture active et relié à une écriture
   comptable contrôlée.
10. **Guider et sceller sans données fictives — livré en 1.18** :
    checklist de première utilisation calculée depuis six preuves métier réelles ;
    clôture comptable et TVA cumulative, avec rejeu idempotent strict et
    corrections postérieures référencées ; régime suisse des salaires de minime
    importance dérivé des cumuls locaux, avec décision, preuve et trace annuelle,
    rattrapage lors du franchissement du seuil et exception LAA conditionnée à
    tous les salariés concernés de l'année.
11. **Planifier et importer sous contrôle — livré en 1.19 source** : agenda
    jour/semaine/mois, relances locales préparées périodiquement et import
    déterministe d'un message fournisseur exporté. Aucun message n'est envoyé et
    aucune facture n'est validée sans action de l'utilisateur.
12. **Collaborer sans abandonner le local** : rôles Windows locaux, paquet
    fiduciaire chiffré, puis compagnon terrain synchronisé volontairement.

## Limites à ne pas masquer

- Zentra ne revendique aucune certification ou homologation AFC, Swissdec/ELM ou
  Olico. Le XML eCH-0217 v2.0.0 est généré localement pour un import manuel dans
  Décompte TVA pro : Zentra ne le transmet pas, et ne garantit ni son acceptation
  ni le décompte final. L'utilisateur doit vérifier, compléter et soumettre le
  décompte dans le Portail AFC.
- Le dossier fiduciaire DRAFT/FINAL, son manifeste et ses empreintes SHA-256
  facilitent une conservation et une révision orientées CO/Olico. Ils ne
  constituent pas une certification Olico : la conformité finale dépend aussi
  des processus, supports, accès, sauvegardes et migrations de l'entreprise.
- Une connexion bancaire directe dépend de la banque, de ses autorisations et
  d'un contrat technique. L'import ISO 20022 local reste le socle fiable.
- Un accès fiduciaire simultané et un compagnon mobile demandent une
  synchronisation chiffrée; ils ne peuvent pas être simulés avec des données de
  démonstration.
- Les cartes, crédits et services financiers de type bexio Pay ne font pas
  partie du cœur Zentra.
- La version 1.8 facture progressivement le livré des lignes de vente
  concernées et facture directement les prestations sans BL. Elle ne crée pas
  encore un acompte défini librement par montant ou pourcentage.
- Une facture fournisseur peut rester autonome ou être rapprochée à plusieurs
  commandes compatibles dans une transaction unique. L'écart est contrôlé sur
  l'ensemble de la facture, avec une tolérance maximale d'un centime sur les
  totaux HT, TVA et TTC, et non une tolérance multipliée par commande. Une
  ventilation existante sur plusieurs commandes ne peut pas être remplacée
  silencieusement : son retrait doit être confirmé explicitement.
- L'avoir fournisseur est un document comptable distinct, imputable à une
  facture validée; il ne remplace pas la facture dans le rapprochement entre
  commande, réception et facture.
- L'OCR des factures et avoirs fournisseurs n'est pas livré. L'OCR local déjà
  présent concerne uniquement l'import de documents de paie.
- Les relances restent supervisées : Zentra peut préparer une relance et ouvrir
  un e-mail prérempli, mais aucun envoi automatique réel n'est livré et aucun
  message ne part seul.
- La date de paiement sélectionne la fenêtre de validité des cotisations et les
  cotisations calculées par taux sont arrondies commercialement au CHF 0.05.
  Les gardes 2026 vérifient les paramètres AAP/AANP/CAF, le cumul LAA et le
  régime documenté des salaires minimes. Le seuil ordinaire est CHF 2'500 ;
  dans un ménage privé, l'exception de CHF 750 ne vaut que jusqu'à la fin de
  l'année des 25 ans, tandis que les autres emplois de ménage et les activités
  artistiques/culturelles visées sont cotisants. La demande de cotiser est
  prospective et un franchissement de seuil entraîne un rattrapage dérivé des
  bases locales. Hors secteurs obligatoirement cotisants, l'exception LAA n'est
  retenue que si tous les salariés concernés pendant l'année remplissent les
  conditions et si la preuve annuelle est conservée. Ces contrôles ne remplacent
  pas une décision de l'assureur, de la caisse ou de la fiduciaire. Zentra ne
  calcule pas encore la QST de manière
  autonome, ne couvre pas tous les règlements LPP ni les clauses IJM, ne produit
  pas le certificat annuel, ne génère ni ne transmet de déclaration ELM et
  n'est pas certifié Swissdec. Ces aides ne constituent ni une validation de
  conformité globale, ni une certification.
- Une planification récurrente ne fonctionne que lorsque l'application de bureau
  est ouverte. Elle crée des brouillons à contrôler et ne constitue ni un
  service cloud d'envoi, ni une émission ou comptabilisation automatique.
- Dans le cycle achats, ni la commande, ni le brouillon de réception, ni la
  facture, l'avoir, le rapprochement, le paiement ou la comptabilisation ne
  modifient le stock. Seules l'émission d'une réception et son extourne créent
  respectivement l'entrée et le mouvement inverse pour les articles suivis.
- Le centre TVA 1.9 bloque l'export lorsqu'un profil manque ou qu'une source
  taxable reste non classée. Les choix de méthode effective ou TDFN/TaF, de
  contre-prestations convenues ou reçues et de périodicité doivent correspondre
  aux autorisations et à la situation réelles de l'entreprise.
- Le statut FINAL indique qu'une période locale a été verrouillée après une
  revue portant sur la même empreinte. Il ne signifie pas que la fiduciaire,
  l'AFC ou une autre autorité a validé les comptes.
- La protection 1.18 est cumulative : une clôture plus récente scelle aussi les
  dates antérieures non couvertes par une clôture distincte. Le rejeu autorisé
  doit être strictement identique ; toute mutation historique est refusée et
  toute correction réelle doit être postérieure à la borne et liée à l'original.

## Sources officielles

- [Fonctions Bexio](https://www.bexio.com/fr-CH/fonctions)
- [Comparatif détaillé des forfaits, état au 28 mai 2026](https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf)
- [Processus de vente et dépenses](https://www.bexio.com/fr-CH/gestion-des-processus-de-vente-et-des-depenses)
- [Facturation](https://www.bexio.com/fr-CH/logiciel-de-facturation)
- [Traitement des commandes](https://www.bexio.com/fr-CH/traitement-commande)
- [Bulletins de livraison](https://www.bexio.com/fr-CH/bulletin-de-livraison)
- [Achats et dépenses](https://www.bexio.com/fr-CH/gestion-des-depenses)
- [Comptabilité](https://www.bexio.com/fr-CH/logiciel-de-comptabilite-pme)
- [Banking](https://www.bexio.com/fr-CH/banking)
- [Gestion de projet](https://www.bexio.com/fr-CH/logiciel-de-gestion-projet)
- [Gestion des stocks](https://www.bexio.com/fr-CH/gestion-des-stocks-pme)
- [Comptabilité salariale](https://www.bexio.com/fr-CH/comptabilite-salaire)
- [AVS/AI — mémento 2.04, cotisations sur les salaires minimes](https://www.ahv-iv.ch/Portals/0/Documents/Merkblaetter/Gruppe_2/2.04_f.pdf)
- [Bexio Go](https://www.bexio.com/fr-CH/bexiogo?wizard=true)
- [Documentation API](https://docs.bexio.com/)
- [AFC — Taux de la TVA suisse](https://www.estv.admin.ch/fr/taux-de-la-tva-suisse)
- [eCH-0217 v2.0.0 — Décompte TVA](https://www.ech.ch/fr/ech/ech-0217/2.0.0)
- [Loi fédérale régissant la TVA (LTVA)](https://www.fedlex.admin.ch/eli/cc/2009/615/fr)
- [Ordonnance régissant la TVA (OTVA)](https://www.fedlex.admin.ch/eli/cc/2009/828/fr)
- [Code des obligations (CO)](https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr)
- [Ordonnance concernant la tenue et la conservation des livres de comptes (Olico)](https://www.fedlex.admin.ch/eli/cc/2002/216/fr)
- [SECO — Conservation électronique des livres de comptes](https://www.kmu.admin.ch/fr/conservation-electronique-des-livres-de-comptes)
