# Assistant Automation — contrôle du 21 septembre 2026

## Validé

- Windows CircleCI job 17, source `cf61ba58f21416450b039fbe0b33bcf94370534d`, terminé avec succès : 39 tests d’interface et 69 tests Rust passent (2 tests préexistants ignorés). Les 9 tests de réception fournisseurs passent, dont confirmation finale idempotente, écriture équilibrée et annulation atomique en cas d’erreur.
- Contrôle local TypeScript sans erreur ; 24 tests ciblés UI/traductions passent après ajout des libellés fournisseur.
- Recette navigateur synthétique à 390 px : document PDF, modification de référence, ajout/sélection de fournisseur sans quitter le formulaire, refus de TVA vide et reprise après correction. L’enregistrement de cette recette est simulé ; les écritures réelles sont couvertes par les tests Rust ci-dessus.
- Nouvelle fiche fournisseur conservant la facture ouverte, préremplie par les informations extraites. La création reste une action explicite. Aucun IBAN n’est prérempli ni paiement envoyé.
- Recette visuelle synthétique à 390 px des vues d’accueil, Automation, réglages, compte, comptabilité, banque, achats, équipe/salaires, agenda, projets, clients, catalogue, devis/factures, relances et temps. Rapports et apparence vus à 1100 px. Les écrans ont été observés, pas chaque formulaire ni chaque opération métier.
- Thèmes clair/sombre du lecteur fournisseur vérifiés à 390 px ; onglets Automation allemands vérifiés à 360 px. Correction des boutons d’aide comprimés, de l’onglet allemand trop étroit et de la césure de la navigation. Retour du sombre au clair vérifié dans les réglages et rapports sur ordinateur.
- Préparation 1.78.0 : build web de production, TypeScript et 53 tests UI ciblés passent. Ces contrôles ne remplacent pas la compilation des exécutables natifs.
- Suite UI complète sur la source 1.78.0 : 1 595 tests passent dans 192 fichiers, journal `outputs/automation-assistant/native-all-ui-tests.log`.
- Source 1.78.0 : `b8caea4a527ee28740150a51cd8bbf82ec2faec6`. CircleCI Apple job 19 terminé avec succès : compilation Mac universelle et IPA physique arm64, 53 tests UI, tests Rust et 4 tests UIKit. WebKit : 141 vues/variantes à 320/390/1440 px, zéro alerte de contraste dans ce périmètre, restauration du thème clair après passage sombre, gestes et zones sûres mobiles contrôlés.
- CircleCI job 20 : le paquet Mac exact du job 19 démarre et se rouvre dans un profil vierge ; intégrité SQLite et clés étrangères vérifiées. Ce contrôle ne constitue pas un essai interactif sur l’appareil d’un client.
- Mac et IPA : téléchargements récupérés, provenance et SHA-256 vérifiés, fichiers versionnés 1.78.0 déposés sur le stockage public et retéléchargés pour comparaison. Signature de mise à jour Mac vérifiée ; canal stable promu en 1.78.0.
- Windows job 18 terminé : 53 tests UI et 69 tests natifs passent (2 ignorés). Job 21 : installation du paquet exact, démarrage et réouverture dans un profil vierge ; SQLite intact, schéma 60 et empreinte de l’exécutable NSIS vérifiés. Signature de mise à jour vérifiée ; téléchargement public retéléchargé puis canal stable promu en 1.78.0.
- Publication GitHub `v1.78.0` vérifiée : 10 fichiers, tag sur la source exacte ci-dessus. Page de téléchargement 1.78.0 publiée sur la source site `373fc1472681a6b29e420d378141e40f9ffc35b6` : version Site 209, déploiement `appgdep_6ab09f9253f081919d882a83722112ad`, succès à 03:08 UTC. Les deux premières tentatives avaient omis le fichier à cause du mauvais nom de paramètre (`archive_path`) ; la reprise avec le paramètre documenté `archive` a joint le paquet vérifié et réussi.

## Non validé / restant

- La connexion réelle Infomaniak est bloquée par HTTP 500 `unexpected_error` sur les dossiers, avec et sans `with=ik-static`. La clé dédiée contient le scope officiel `workspace:mail`, l’adresse exacte est reconnue par la liste API, et le webmail ouvre la boîte normalement. Aucune lecture des mails existants par Zentra ni facture fictive envoyée dans cette séquence.
- La facture fictive `ZT-QA-20260921-01`, CHF 108.10, est prête pour un envoi après connexion. Ne pas présenter les tests simulés comme un test e-mail de bout en bout.
- Synchronisation mail lorsque Support est fermé encore désactivée ; GitHub planifié indisponible pour facturation. Aucun remplacement de planificateur n’a été mis en production.
- Mac non notarié et IPA non signé : aucun essai physique iPhone ni certification Apple revendiqué. Windows sans Authenticode. Android reste en 1.74.0. Les vues non françaises existantes contiennent encore certains textes français ; aucune conformité linguistique exhaustive n’est revendiquée.

Les améliorations d’ajout fournisseur postérieures à `cf61ba58` sont uniquement frontend ; aucune nouvelle modification Rust depuis le job 17.
