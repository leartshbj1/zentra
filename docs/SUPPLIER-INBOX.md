# Factures reçues par mail : Support → Gestion → Automation

## Configuration

1. Installer Gestion 1.76 ou plus récent et connecter l’entreprise partagée.
2. Dans Support → Connexions, connecter une boîte Infomaniak puis choisir explicitement l’entreprise Gestion. L’administrateur doit gérer les deux espaces ; chaque espace reste lié à une seule entreprise.
3. Sans Automation : les justificatifs apparaissent dans Achats → Boîte de réception. L’équipe vérifie le document, crée au besoin son fournisseur, corrige les champs et enregistre un brouillon. La validation comptable reste une action distincte.
4. Avec Automation : activer la fonction « Factures fournisseurs » dans les réglages Automation de Gestion, puis autoriser la comptabilisation automatique dans le raccordement Support. Un appareil Gestion autorisé doit être ouvert, connecté et hors saisie pour terminer l’écriture.

La réception automatique côté serveur dépend du planning décrit dans SUPPORT-MAIL.md. Sans planning actif, l’espace Support doit rester ouvert. La collecte serveur et la comptabilisation locale sont deux opérations différentes.

## Contrôles

- PDF contenant du texte : Jev choisit des valeurs tirées du document avec leurs extraits. Aucun résultat absent n’est remplacé par zéro.
- PDF, PNG et JPEG originaux privés, limités à 6 Mo. Extraction texte limitée à 12 pages et 18 000 caractères. Les scans ou documents illisibles restent à compléter manuellement ; aucune fonction OCR n’est annoncée.
- Comptabilisation automatique seulement en CHF, au moins 95 % de confiance pour chaque champ, sommes et TVA cohérentes, fournisseur unique identifié par son nom et l’expéditeur, catégorie compatible avec un compte de charges précédemment validé. Les cas ambigus passent en vérification.
- L’import actuel utilise une ligne récapitulative HT/TVA. Les factures à plusieurs taux, avoirs, rappels, devis, monnaies étrangères et fournisseurs inconnus ne sont pas automatiquement comptabilisés.
- L’original reste joint à la facture. Le traitement ne paie rien et ne modifie ni ne supprime aucun mail.
- Empreinte du document et identifiant d’import stables. L’écriture, le justificatif et la trace d’import sont transactionnels. Une réponse perdue est récupérée depuis l’appareil ayant commencé l’import, sans nouvel enregistrement.
- La réservation ne se transfère pas silencieusement à un autre appareil : une copie locale peut avoir été enregistrée avant une coupure. En cas de perte définitive de cet appareil, une réconciliation contrôlée est nécessaire.
- Les originaux et états d’import sont réservés aux membres de l’entreprise liée. Les rôles en lecture seule ne peuvent pas importer ni ignorer. La facture créée utilise la synchronisation d’entreprise existante.
- Le bilan quotidien est partagé et compte les imports confirmés après l’écriture locale. Il ne présente pas de gain de temps inventé.
- Chaque document analysé compte dans le volume Support. Les réservations de quota sont libérées si l’analyse ou l’archivage échoue. Une erreur sur un justificatif ne bloque pas les autres tickets Support.

## Validation du 21 septembre 2026

211 tests serveur (14 fichiers) réussis, TypeScript valide. Tests de contrat avec le vrai parseur Jev et transport simulé, PDF texte réel synthétique, accès interentreprises, rôles, consentement, quotas, archivage, doublons et reprise. L’extraction d’un PDF synthétique a aussi réussi dans le moteur Cloudflare workerd local. Le modèle n’a pas été testé sur des factures clients réelles pendant cette livraison.

7 tests natifs Windows réussis sur CircleCI : écriture équilibrée, facture unique après reprise, retour arrière après erreur, brouillon modifié préservé, collision avec une facture étrangère refusée. Aperçu de l’interface en quatre langues, thèmes clair/sombre, écran de 320 pixels et parcours manuel/automatique/lecture seule.

Le parcours de production avec une vraie boîte reste à vérifier après que son propriétaire l’a connectée et a reçu un document d’essai.
