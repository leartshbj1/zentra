# Gros historique et périodes comptables

28 septembre 2026, 01 h 20, Europe/Zurich. Correctifs locaux postérieurs à la version publique 1.90.6, **pas encore distribués**.

## Mesures

Entreprise exclusivement fictive dans un nouveau profil Windows : 501 clients, 101 projets, 5 001 devis, 5 001 factures, 80 002 lignes de documents, 3 334 paiements et 16 670 lignes comptables. Base SQLite de 41,5 Mo avant ouverture. Aucun compte, secret SMTP ou jeton de licence de l’utilisateur copié. Les écritures manuelles de la fixture servent au volume ; elles ne constituent pas une recette d’émission ou d’encaissement réel.

Compilation **debug**, sur ce PC. Ces résultats ne mesurent ni la version optimisée distribuée, ni un démarrage à froid du système, ni 150 entreprises simultanées sur le serveur.

| Mesure | Avant | Après | Protocole |
|---|---:|---:|---|
| Réponse native complète `get_workspace` | 14 758 ms | 8 969 ms | Médiane de trois appels, même profil ; réponse identique. Environ 39 % de temps en moins. |
| Contrôle `get_accounting_continuity` | 5 679 ms | 880 ms | Deux appels par condition sur **le même binaire**, index désactivés puis activés uniquement sur la fixture. Résultat identique, environ 85 % de temps en moins. |
| Interface prête après rechargement du WebView | 15 602 ms | 9 558 ms | Un rechargement instrumenté par version, distinct du démarrage du processus. |

Les trois lectures finales produisent la même empreinte qu’avant correction : `56c7e7adfa555c8d0e0a57f71a03209bd7bdb36e025600b18ffa791459ec9b82`. L’intégralité de la réponse, **49 558 744 octets après sérialisation JavaScript**, reste présente. Aucun champ ni contrôle de cohérence supprimé pour obtenir le gain.

Huit navigations natives finales réussissent sans erreur JavaScript ou débordement : 52 à 128 ms pour Accueil, Rapports, Clients, Projets, Paramètres et Ventes ; 443 ms pour Relances ; 2 258 ms pour Comptabilité. Le premier relevé comptabilité autour de neuf secondes coïncidait avec des travaux de compilation : il reste un signal de diagnostic, pas la base d’un pourcentage de gain. Le comparatif du contrôle comptable ci-dessus a été exécuté après leur fin.

## Correctifs

- Deux index locaux retrouvent directement les avoirs liés à une facture et les lignes d’une écriture. Création idempotente à l’ouverture et après migration/restauration ; aucun champ synchronisé, règle métier ni numéro de schéma changé.
- Les tableaux déjà construits sont déplacés dans la réponse sans les sérialiser/copier une seconde fois. Requêtes, ordre des lignes, champs nuls et contrôles conservés.
- La comptabilité s’ouvre sur l’année explicitement sélectionnée. Les états affichent les bornes renvoyées par leur moteur, y compris lorsqu’un filtre de journal sans bornes fait résoudre un exercice. L’aperçu annuel ne prétend plus couvrir « Toutes les dates ». Les dates restent visibles sur mobile.

Recette native : les montants du 1er janvier au 31 décembre 2026 affichent bien 493 800 CHF de revenus fictifs. Le cumul complet des factures est de 4 001 000 CHF et les paiements de 1 999 850 CHF : ces périodes sont distinctes.

## Vérifications et provenance

- 1 823 tests frontend réussis ; TypeScript, contrôle de 50 actifs et build final réussis. L’avertissement existant sur certains blocs JavaScript de plus de 500 ko demeure.
- Deux tests des index, 24 tests comptables et 56 tests de migration réussis. Après suppression des copies intermédiaires, profilage natif explicite réussi avec relecture JSON identique. Ce test reste ignoré par défaut et refuse un profil sans marqueur fictif.
- Quatre parcours Chromium/WebKit, 1 440/390 px, clair/sombre : année envoyée au moteur, choix du mois, filtre sans bornes, retour à l’aperçu et dates affichées. Captures relues ; pas d’erreur JS ou de débordement. Le thème sombre utilise le vrai réglage de l’application.
- Avant/après et après fermeture : **110 tables métier comparées, trois fichiers conservés, montants inchangés, aucune erreur d’intégrité ou de clé étrangère, journal équilibré**. L’instance de test se ferme normalement, code 0. La version installée de l’utilisateur reste 1.90.5 avec la même empreinte.

Binaire final de recette : SHA-256 `CE29AE1AE596407A64511DE031CCB1E82628F168973D6B5C89B7E11C033F9B76`. Son numéro technique 1.90.6 ne permet pas de remplacer les paquets publics de même version. Une nouvelle version sera nécessaire pour livrer ces sources.

Preuves : `outputs/native-volume-20260928/` — `fixture.json`, `index-comparison.json`, `final-check.json`, `rust-profile{,-final}.log`, `*-snapshot.json`, `installed-app-unchanged.json`, journaux de tests/build ; parcours `desktop/tests/accounting-period-truth-journey.mjs` et `desktop/.qa/accounting-period-truth/`.

## Limites restantes

Le gros historique conserve une réponse d’environ 50 Mo et une attente perceptible en debug. La lecture à la demande/pagination des données natives et la recette sur matériel modeste restent à mesurer ; ne pas annoncer une ouverture instantanée.

À **01 h 18**, le service de connexion répond encore **503**, `Retry-After: 60`, à une adresse fictive inexistante, sans cookie, inscription ou envoi d’e-mail. Les essais de synchronisation connectée, d’abonnement et d’Automation restent ouverts. Le dernier diagnostic direct Supabase indiquait des quotas dépassés ; ce n’est pas un nouveau contrôle de facturation.

Ce lot n’apporte ni signature Windows, ni notarisation Mac, ni validation physique iPhone/Android. [État global des vingt points](AUDIT-PREMIER-CLIENT-ETAT-20260928.md).
