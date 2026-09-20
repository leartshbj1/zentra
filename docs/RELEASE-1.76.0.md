# Zentra 1.76.0 — factures fournisseurs depuis la messagerie

Zentra Support peut être relié explicitement à une entreprise Gestion. Les pièces Infomaniak arrivent dans une boîte de réception fournisseurs partagée. La vérification présente le justificatif et les champs côte à côte sur ordinateur, puis l’un sous l’autre sur mobile.

Sans Automation, l’utilisateur complète et enregistre un brouillon avant la validation comptable. Avec Automation et son accord, une facture cohérente d’un fournisseur connu peut être comptabilisée avec le compte de charges déjà validé. Une catégorie différente, un nouveau fournisseur, un total incohérent ou une extraction incertaine restent à vérifier. Le traitement ne paie aucune facture.

Le bilan quotidien montre les documents reçus, comptabilisés automatiquement et à vérifier. Il utilise des imports effectivement confirmés, sans estimation arbitraire de temps gagné.

## Périmètre

- Infomaniak connecté dans Support ; chaque espace est lié à une entreprise Gestion choisie par son administrateur.
- Extraction de PDF contenant du texte. PNG/JPEG, scans et documents illisibles conservés pour saisie manuelle. Limites : 6 Mo, 12 pages, 18 000 caractères pour l’extraction.
- Une ligne récapitulative HT/TVA à l’import ; les factures à plusieurs taux ou en monnaie étrangère restent manuelles.
- Gestion doit être ouverte, connectée et disponible pour terminer la comptabilisation locale. La collecte quand toutes les applications sont fermées dépend du planning serveur.
- Droits d’entreprise, transactions et identifiants stables ; une interruption ne crée pas un deuxième import. Une réservation interrompue reprend sur son appareil d’origine.

## Validation

Source des paquets : `ed48720a27b01273bf86d713482a27760f2faf9b`.
Pipeline CircleCI 17 : Windows 9 et Apple 10 réussis. Tests des paquets Windows 12 et Mac 11 réussis : démarrage, relance, migration 60 et intégrité SQLite dans des profils jetables. Les contrôles de source, architecture, empreintes et clé de mise à jour embarquée sont passés. Chaque plateforme a passé 39 tests UI et 46 tests natifs ciblés (un diagnostic client volontairement ignoré).

Le serveur a passé 211 tests sur 14 fichiers, puis sa compilation de production. L'extraction d'un PDF synthétique a également fonctionné dans Cloudflare workerd local. Le site avec la migration 0055 a été publié en version 195.

Les tests serveur incluent le vrai contrat Jev avec transport simulé, un PDF synthétique réel, les rôles, les quotas, la confidentialité, les doublons et la reprise. Les tests natifs vérifient l’écriture équilibrée, le retour arrière après erreur et la préservation d’un brouillon modifié.

Le nouveau parcours a été utilisé en aperçu avec des données fictives : vérification, ouverture du PDF, création du brouillon, traitement automatique et consultation seule. Langues FR/DE/IT/EN, thèmes clair/sombre et largeur de 320 pixels vérifiés.

Pas de test sur une boîte client réelle ni sur un iPhone physique. L’IPA reste non signé pour installation manuelle ; Mac conserve une signature ad hoc sans notarisation Apple. Windows ne possède pas de signature Authenticode. Les mises à jour Windows/Mac sont signées Ed25519, vérifiées localement et après téléchargement public.

Les canaux Windows/Mac et les fichiers Windows/Mac/iPhone 1.76.0 sont publiés dans le stockage Zentra. Android reste en 1.74.0. Les preuves sont conservées dans `outputs/release176`.

La réception quand Support est fermé n'est pas encore activée : l'ancien planning GitHub est bloqué. Le planning Supabase préparé attend la confirmation de l'utilisateur avant de lui confier son jeton technique. Aucune promesse de collecte permanente tant que ce raccordement n'est pas validé.

Empreintes SHA-256 :
- Windows : `60e6ca4aa121d0b67be2ed2cb6018de85dea7c1b538c1b4442d75a7b25d55e95`
- Mac DMG : `c6c9e7398ae7fec141f939d7407affb4fbe5bd3ae3abc6dc795e4794812a5a10`
- Mac mise à jour : `ea9cb68c02b4d2ac0ae49a05022750d59be986264fddfca15df85e1adbef13cf`
- iPhone IPA : `7865ac76a2407e8a51795a4133b01536e8628e5a7747956e18f4626131bf1183`
