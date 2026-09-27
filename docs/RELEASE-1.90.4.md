# Zentra 1.90.4 — préparation

Cette version rassemble les correctifs natifs postérieurs à 1.90.3 : remboursements après changement de droits, taille du texte, ouverture de l’entreprise, rapports PDF, détail des chiffres de l’accueil, recherche dans les réglages, navigation mobile, chargement de la langue choisie, pagination des grandes listes et personnalisation/import sur téléphone.

Le 27 septembre 2026 : 1 749 tests frontend dans 218 fichiers et la compilation web complète passent sur la source préparée. Les recettes ciblées et leurs limites restent dans `AUDIT-PREMIER-CLIENT-SUIVI.md`. La compilation conserve un avertissement de poids de certains modules ; ce n’est pas une mesure de vitesse native.

La branche `codex/first-client-release-1904` déclenche une seule préparation Windows, Apple et Android. Les fichiers ne doivent être signés puis publiés qu’après vérification de la source exacte, des empreintes et des contrôles du paquet. Les versions, les notes de mise à jour et le verrou Rust sont alignés sur 1.90.4.

Statut initial : aucune publication de 1.90.4. Cette version n’annonce pas le rétablissement du compte distant, des quotas Supabase, du planificateur autonome ni des signatures de distribution des plateformes. Les preuves de livraison et les limites de chaque fichier seront ajoutées après compilation dans `outputs/release1904`.
