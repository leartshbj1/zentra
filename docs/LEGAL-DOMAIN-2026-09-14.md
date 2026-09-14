# Domaine et documents Zentra — 14 septembre 2026

## État vérifié

- zentraapp.ch et www.zentraapp.ch : DNS conformes, validation Sites et TLS actifs, réponses HTTPS 200 après réactivation des associations existantes.
- Aucun remplacement des MX ou changement de serveur DNS Infomaniak. La boîte info@zentraapp.ch existe dans le compte du titulaire et devient le contact public à sa demande.
- Éditeur confirmé : Shabija Leart, Avenue de Châtelaine 72, 1219 Châtelaine, Suisse ; non assujetti à la TVA suisse.
- Adresse vérifiée auprès du gestionnaire de l’immeuble : https://www.fidp.ch/parc-immobilier/item/chatelaine-72 (aucune identité de résident déduite).
- Supabase : Site URL changé pour https://zentraapp.ch ; les deux callbacks du nouveau domaine et ceux de l’ancien sont conservés. HTTPS et la confirmation d’e-mail restent activés.
- Sites : PUBLIC_SITE_URL et NEXT_PUBLIC_SITE_URL deviennent https://zentraapp.ch, révision d’environnement 27. Les origines historiques restent autorisées pour les sessions et applications installées. Le webhook Stripe existant est conservé pour éviter de casser la facturation.

## Documents et données

Pages /mentions-legales, /conditions, /confidentialite, /cookies, /sous-traitance avec sommaire, impression/PDF et liens de pied de page.

Inscription : acceptation explicite exigée côté serveur, version et date serveur transmises dans les métadonnées du compte Supabase. Ces métadonnées ne constituent pas un registre immuable ni une preuve autonome de l’identité du demandeur.

Paiement : acceptation explicite de la version courante exigée pour un utilisateur authentifié avant la création du Checkout. La migration additive 0037 crée legal_acceptances. La version, l’identité serveur, la formule et le Checkout sont enregistrés dans la même transaction que la tentative de paiement. Ce fait constate une demande de Checkout, pas un paiement ni un contrat exécuté.

Les anciennes constantes de format, clés de licence et identifiants d’application demeurent compatibles : renommer ces identifiants effacerait l’accès à des données ou rendrait des licences existantes illisibles. Aucune ancienne marque ne reste dans les textes visibles du site.

## Contrôles et limites à finaliser avant lancement commercial

- Vérifier les accords de sous-traitance effectivement applicables à OpenAI Sites, Supabase, Cloudflare, Stripe et aux transports e-mail, ainsi que les pays et mécanismes exacts de transfert. Les pages publiées ne remplacent pas ces contrats.
- Formaliser la procédure opérateur de traitement des demandes d’accès/suppression : vérification d’identité, inventaire multi-stockages, obligations de conservation, effacement, copies techniques et réponse au demandeur. Ne pas annoncer une purge automatique inexistante.
- Confirmer et tester le SMTP de production et la réception des inscriptions, récupérations et confirmations de commande. La boîte de support Infomaniak est distincte du transport Supabase.
- Les paiements restent en test propriétaire ; aucune bascule Stripe live ni modification de compte marchand n’est réalisée ici. Avant activation commerciale, aligner identité, adresse, non-assujettissement, reçus et informations légales Stripe avec ces documents.
- Faire relire les conditions et l’annexe de traitement pour les contraintes des activités clientes. Ni certification LPD/RGPD, ni certification Swissdec ne découle de cette publication.

## Validation de cette publication

- 64 tests ciblés réussis : authentification, origines, contrats Stripe, migrations, invitations et acceptation juridique.
- La simulation de panne d’écriture vérifie le rollback et l’absence d’URL de paiement livrée sans enregistrement ; aucune facturation réelle ni aucun e-mail de test n’a été envoyé.
- Vérification TypeScript réussie. Correction de typage d’un résultat JSON dans un test d’invitation préexistant, sans changement métier.
- Les cinq pages légales sont lisibles à 390 pixels, sans débordement horizontal, sans ancienne marque visible et sans lien vide. Case d’acceptation d’inscription obligatoire, non précochée.
- Domaine et www accessibles en HTTPS ; nouvelle adresse canonique et ancien alias couverts par les tests de conservation de l’origine de session.

## Références officielles et factuelles

- SECO, informations et commande en ligne : https://www.kmu.admin.ch/fr/obligations-legales-les-lois-suisses-et-europeennes-sur-le-e-commerce
- PFPDT, devoir d’informer : https://www.edoeb.admin.ch/fr/devoir-dinformer
- PFPDT, sous-traitance : https://www.edoeb.admin.ch/fr/externalisation-sous-traitance
- PFPDT, transferts : https://www.edoeb.admin.ch/fr/communication-de-donnees-a-letranger
- PFPDT, exercice des droits : https://www.edoeb.admin.ch/fr/connaitre-et-faire-valoir-mes-droits
- Supabase, périmètre régional et responsabilité partagée : https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/security/gdpr-compliance.mdx

Conserver cette version des textes avec le commit publié ; toute modification matérielle devra recevoir une nouvelle version juridique.
