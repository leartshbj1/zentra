# Centre Automation — livraison du 22 septembre 2026

## Utilisation

Ouvrir l’entreprise concernée, puis Automation → Centre Automation → Règles. Sur le site : Compte → Automation → Règles. Le titulaire ou un administrateur choisit un modèle, le personnalise, vérifie sa simulation et l’active pour les prochains messages classés dans Support. L’abonnement et les réglages de cette entreprise doivent autoriser le traitement des e-mails.

Les quatre vues sont **À vérifier**, **À faire**, **Historique** et **Règles**. Les brouillons et tâches sont partagés dans l’entreprise selon les rôles et affectations. Une modification concurrente d’un brouillon est signalée au lieu d’écraser le travail de l’équipe.

Les modèles de réponses acceptent les champs `{{objet}}`, `{{expediteur}}`, `{{categorie}}` et `{{priorite}}`. Le texte reste personnalisable ; aucun brouillon n’est envoyé automatiquement. Les résumés reprennent au maximum cinq extraits exacts du message, avec son objet, son expéditeur et les noms des pièces jointes. Ils ne prétendent pas décrire le contenu d’une pièce jointe non lue. Les coupures sont signalées.

Les règles acceptent des conditions sur la catégorie, la priorité, un expéditeur précis et la présence d’une pièce jointe. Un nœud de décision peut départager deux branches. Une décision incertaine ou RH reste soumise à validation humaine. Les calculs comptables et les paiements ne sont pas des actions de cet éditeur.

## Exécution et limites

Les tâches, notifications, résumés et brouillons créés par ces règles restent dans le Centre Automation. Les factures fournisseurs et rendez-vous conservent leurs propres contrôles de réception dans Gestion.

Le traitement immédiat et la reprise pendant l’ouverture du centre sont opérationnels. La reprise utilise le contexte serveur Cloudflare `waitUntil`, sans retenir la réponse de l’interface, et uniquement pour l’entreprise authentifiée. Les droits, l’abonnement, les réglages et la version de la règle sont revérifiés avant chaque action.

Le fonctionnement permanent lorsque personne n’est connecté exige le planificateur distant. Son remplacement Supabase est préparé, mais son activation attend l’autorisation de créer cette connexion technique. Ne pas annoncer que les délais s’exécutent en permanence avant d’avoir vérifié un vrai passage programmé. Source officielle du mécanisme : https://supabase.com/docs/guides/functions/schedule-functions ; exécution après réponse : https://developers.cloudflare.com/changelog/post/2025-08-08-add-waituntil-cloudflare-workers/.

L’annulation concerne uniquement des éléments encore inutilisés, non modifiés. Une reprise conserve les identifiants des étapes pour éviter les doublons. Un traitement interrompu garde un état explicite et peut être repris avec les droits appropriés.

## Couverture de la demande élargie

Cette livraison ajoute l’éditeur de règles de messagerie, ses branches et délais, les modèles, les résumés extraits, les tâches partagées, les modes d’autonomie, le suivi, les reprises, l’annulation limitée et les compteurs quotidiens réels. Elle étend les catégories Support à commande, SAV, réclamation, administratif, RH et indésirable.

Elle ne livre pas encore l’ensemble de la liste élargie : tous les déclencheurs métier, centre de validation unique pour tous les modules, envoi automatique des réponses, rapprochement de paiements multiples par cet éditeur, cycle commande/réception/facture, dossier SAV complet jusqu’au paiement, apprentissage de séquences arbitraires, recherche universelle d’actions manquantes et annulation générale inter-produits restent à développer et à valider. Les fonctions préexistantes de réception fournisseurs, agenda et suggestions bancaires ne prouvent pas ces chaînes complètes.

## Preuves

- 410 tests serveur ciblés réussis, aucun échec ; TypeScript et build réussis.
- 49 tests locaux d’interface native réussis ; compilation web réussie.
- Source native 1.81.0 : `49d7b269212a35741645d552190e0890e845608e`.
- CircleCI : Android 63, Windows 64, Apple 65 réussis. Installation/démarrage et réouverture des paquets exacts : Windows 67 et Mac 66 réussis dans des profils jetables.
- Les cinq tests Rust Automation passent sur Mac ; les suites compte, synchronisation, réception fournisseurs, agenda et contrôles mobiles de la compilation passent également.
- Recette du nouveau centre à 390 px en clair et sombre ; simulation vérifiée dans le compte réel sans créer ni activer de règle de production.
- Les nouveaux tests de décision Jev utilisent des réponses simulées. Aucun nouveau score de précision réelle, gain de temps mesuré ou essai sur téléphone physique n’est revendiqué.
- Windows et Mac ont une signature de mise à jour vérifiée ; Windows reste sans Authenticode, Mac non notarié, IPA non signé et APK de préversion. Aucune publication dans les boutiques Apple/Google.
