# Sauvegarde et restauration — contrôle du 27 septembre 2026

## Défauts traités

- Une archive ZIP et une base SQLite valides pouvaient référencer un document ou un logo absent ou modifié. La restauration manuelle et la récupération du coffre contrôlent désormais les tailles et les SHA-256 enregistrés **avant** la copie de sécurité et le remplacement. Les anciens justificatifs génériques sans SHA-256 restent contrôlés par présence et taille ; aucun contrôle cryptographique n’est inventé pour eux.
- La création manuelle et la préparation d’une sauvegarde du coffre refusent une copie incomplète. Un échec ne remplace pas la preuve de dernière réussite. Le fichier temporaire est supprimé à la sortie et l’installation finale utilise `persist_noclobber` pour ne pas écraser une copie existante.
- Les fichiers doivent rester dans le répertoire des pièces jointes ; aucun chemin de l’ancien ordinateur n’est utilisé pour valider le contenu restauré. Les liens symboliques ne sont pas acceptés comme pièces d’une sauvegarde complète.
- Une restauration native réussie suivie d’un échec de lecture est distinguée d’une restauration refusée. Depuis les paramètres, la reprise relit l’entreprise sans répéter la restauration, pour les copies locales et le coffre. Une erreur du sélecteur de fichiers reçoit un message ; l’annulation ne restaure rien.

Le protocole de copies utilisé par la collaboration reste séparé : cette vérification complète ne rajoute pas un parcours de tous les documents à chaque synchronisation. Les copies de sécurité avant restauration continuent à préserver l’ancien état, même s’il contient déjà une pièce manquante. Elles ne sont pas annoncées comme une nouvelle copie complète vérifiée.

## Interface

Dernière copie visible à une taille lisible ; « Créer une sauvegarde » en premier et « Restaurer » à côté ou dessous. Dossier préféré et engagement de conservation passent dans « Options de sauvegarde ». Le bandeau « Base locale », redondant, est retiré. Les nouvelles instructions existent en français, allemand, italien et anglais ; le coffre et d’autres libellés anciens ne sont pas déclarés entièrement traduits.

Deux tours visuels limités, conservant les couleurs et composants existants. WebKit 390 FR clair, Edge 1440 FR sombre, WebKit 320 DE sombre avec texte 200 %. Les 16 parcours contrôlent sauvegarde, dernier état, annulation, choix de fichier refusé, archive refusée et relecture locale/coffre sans double restauration. Aucun débordement horizontal ni exception JavaScript dans ces cas. Les services natifs de ces captures sont simulés.

## Validation et limites

- 163 tests frontend dans quatre fichiers passent, dont quatre nouveaux contrats de restauration et la couverture des clés de traduction. Les premières exécutions ont révélé un retour de hook de test incorrect et une traduction manquante ; les deux sont corrigés.
- TypeScript, icônes de marque et compilation Vite passent. L’avertissement de poids du module Excel reste présent.
- Détecteur ciblé : `[]`. Captures et résultats : `desktop/.impeccable/review/backup-recovery/`. Journaux : `outputs/backup-recovery-{unit,ui,build}.log`.
- Windows 142 a échoué **à la compilation** sur le type du nouveau fichier temporaire. Correction `a7a503d8` ; nouvel essai 143 en cours au moment de cette note.
- Les nouveaux scénarios natifs utilisent de vrais fichiers `.zentra`, des bases SQLite isolées, un PDF et un logo. Ils visent une source devenue inaccessible, des pièces absentes ou altérées à taille égale, une archive tronquée, la préservation de la dernière réussite et le retour arrière après une erreur finale. Leur résultat distant sera consigné ici.

Aucune sauvegarde client restaurée, aucun paquet natif publié dans ce lot. La récupération par l’interface d’un installateur réel, le partage de fichier iPhone/Android, la reconnexion au compte et la comparaison exhaustive des factures, salaires et écritures sur deux appareils restent à démontrer. Ce lot ne vaut pas validation complète du point 6 de l’audit.
