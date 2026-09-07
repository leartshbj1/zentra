# E-mails de connexion Zentra

Supabase Auth conserve les comptes, les mots de passe, les sessions et les liens de confirmation. Resend fournit uniquement le transport SMTP des messages.

## Préparation du 7 septembre 2026

- Connexion Resend établie avec le compte GitHub du propriétaire.
- Intégration Supabase autorisée pour l'organisation **Shabija Leart**.
- Projet sélectionné : **Zentra Zurich**, `xvfohjdlhlirksrvkiqu`.
- L'assistant Resend est à l'étape **Link domain**. Le propriétaire fournira le domaine après son achat.
- Aucun domaine inventé, aucune clé SMTP provisoire et aucun envoi client activé. Supabase utilise encore son transport de test.

## Activation après réception du domaine

1. Ouvrir [l'intégration Resend](https://resend.com/settings/integrations), puis le projet Zentra Zurich.
2. Ajouter un sous-domaine d'envoi du domaine fourni par le propriétaire. Recopier exactement les enregistrements DNS affichés par Resend et attendre leur validation. Ne pas remplacer les MX du domaine principal utilisés par une boîte mail existante.
3. Créer la clé de cette intégration avec l'autorisation d'envoi. L'assistant doit configurer uniquement ce projet Supabase. Garder la clé dans les réglages SMTP, jamais dans Git, dans les captures ou dans les journaux.
4. Choisir le nom d'expéditeur **Zentra** et une adresse appartenant au domaine vérifié. Le serveur est `smtp.resend.com`, le port `465` et l'utilisateur `resend`. Le mot de passe est la clé d'envoi Resend. Désactiver le suivi des liens sur les messages d'authentification.
5. Conserver la confirmation d'adresse et la rotation des sessions. La redirection actuellement autorisée est `https://elyko.alb-leart1.chatgpt.site/api/auth/confirmation`. Changer le domaine d'envoi ne nécessite pas de déplacer le site ni les API de l'application.
6. Vérifier la réception d'une inscription, la confirmation dans le navigateur d'origine, la reprise du lien d'invitation et le mot de passe oublié. Le nouveau mot de passe doit invalider les sessions d'appareil. Un test réussi de l'API de connexion seule ne prouve pas la livraison des e-mails.

Les tests du 7 septembre ont validé les connexions de deux comptes personnels distincts, le refus d'un mot de passe incorrect, le renouvellement de session, le changement de mot de passe et la déconnexion globale. Les comptes temporaires ont été supprimés. La livraison des messages reste à vérifier après activation du domaine.

Sources : [Resend avec Supabase SMTP](https://resend.com/docs/send-with-supabase-smtp), [restrictions du transport intégré Supabase](https://supabase.com/docs/guides/auth/auth-smtp).
