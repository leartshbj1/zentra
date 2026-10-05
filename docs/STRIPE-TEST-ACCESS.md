# Comptes de paiement Stripe sandbox

Le mode serveur `STRIPE_TEST_MODE=accounts_only` ouvre les routes de paiement
existantes aux seuls comptes confirmés figurant dans
`STRIPE_TEST_ACCOUNT_USER_IDS`. Cette variable serveur contient un tableau JSON
de 1 à 20 identifiants UUID Supabase uniques, par exemple :

```json
["a1111111-1111-4111-8111-111111111111"]
```

L’exemple est fictif. Utiliser les identifiants des comptes ordinaires créés dans
l’environnement d’authentification isolé, jamais une liste d’adresses e-mail,
un domaine ou `*`. Les UUID sont comparés sans distinction de casse. Une liste
absente, vide, malformée, doublonnée, de plus de 20 comptes ou de plus de 4096
caractères refuse toute admission sandbox. Supprimer un compte de cette liste
referme ses prochaines demandes de paiement ; les contrôles sont rejoués à
chaque demande. Cela ne résilie pas une session Stripe déjà ouverte.

Ce mode exige une clé `sk_test_`. Il ne donne aucun droit Support, quota, essai,
offre, licence, accès administrateur ou accès fondateur. Garder
`OWNER_ACCOUNT_USER_ID` et `ZENTRA_OWNER_EMAIL` réservés à leurs véritables
identités administratives ; ne pas y placer les clients de recette. La liste ne
doit apparaître ni dans des variables client/Vite, ni dans les réponses API ou
les journaux.

Le mode historique `owner_only` conserve son comportement : clé test et compte
propriétaire confirmé identifié par l’ID ou l’e-mail serveur. L’autorisation
avec une clé live reste inchangée et ignore la liste sandbox ; les contrôles
existants de compte confirmé et de paiement restent applicables. Un mode test
absent ou inconnu reste fermé.

`accounts_only` conserve Stripe Tax obligatoire. L’exception Tax historique
reste limitée à `owner_only` avec une clé test. Les contrôles d’origine, de
consentement, de fréquence, de catalogue/prix, de mode Stripe, de signature et de
preuve récente d’un webhook réel, de readiness et de facture payée ne sont pas
modifiés. L’admission au checkout ne prouve ni un paiement ni un droit produit.

Configurer ce mode uniquement dans un environnement sandbox distinct, avec son
propre Supabase, sa base D1, son coffre R2, son origine HTTPS et ses secrets
Stripe/signature. Le présent lot n’applique aucun de ces réglages à un
environnement. Il ne crée pas de compte, ne contacte pas Stripe et n’ajoute
aucune horloge de test ni exemption de temps. Les tests fermés sur route,
persistance SQLite et transport Stripe simulé ne remplacent pas la recette
réelle inscription → essai → invitation → paiement → changement → renouvellement
et expiration.
