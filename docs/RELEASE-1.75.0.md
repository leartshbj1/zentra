# Zentra 1.75.0 — candidate de publication

Synchronisation des entreprises par blocs de contenu réutilisables, avec notifications temps réel et reprise des transferts. Le serveur vérifie toujours l’accès à l’entreprise pour chaque requête. Une connexion temps réel active évite les vérifications complètes répétées ; une interruption rétablit les vérifications de secours.

Les archives reconstruites sont contrôlées intégralement avant leur fusion. Les règles existantes sur les encaissements, la numérotation, les modifications concurrentes et la conservation des données locales restent appliquées. Les anciennes versions conservent leur protocole de transfert.

## Construction

Le workflow CircleCI est désactivé par défaut. Après contrôle des crédits gratuits du compte, lancer une seule pipeline avec le paramètre booléen `release=true`. Il compile Windows x64/MSVC et Mac universel avec un IPA ARM64 pour iPhone physique. Les tests natifs de collaboration et de compte doivent réussir avant la compilation des installateurs. Aucun secret de production ni clé privée de signature n’est transmis à ce service.

Les paquets Windows et Mac doivent être signés localement pour les mises à jour Tauri, vérifiés puis retéléchargés après publication avant de modifier les canaux publics. Le Mac conserve une signature ad hoc sans notarisation. L’IPA n’a pas de signature Apple de distribution.

## État

Version préparée, non publiée. Les résultats natifs et les empreintes des fichiers seront ajoutés uniquement après validation des compilations. Ne pas annoncer cette version dans les téléchargements avant vérification des fichiers.
