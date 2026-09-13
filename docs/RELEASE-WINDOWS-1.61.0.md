# Windows 1.61.0

## Contenu

- Documents : Inter et Literata sont disponibles pour le corps, les titres et les passages sélectionnés, en normal, gras, italique et gras italique. Les polices sont incluses dans l’application et les PDF pour fonctionner hors ligne, avec les mêmes formes et mesures à l’écran et à l’export.
- Factures d’acompte et de solde : préparation en trois étapes, **Prestation → Paiement → Vérifier**. Les dates d’échéance suivent les conditions choisies et restent modifiables. La prestation peut être reprise depuis l’autre facture liée.
- Les erreurs renvoient à l’étape et au champ à corriger. Une écriture en cours ne peut pas être envoyée deux fois ; les modifications sont conservées après un refus. Sur mobile, le champ actif reste visible au-dessus des actions.

Les modèles, couleurs, logo, marges et paragraphes de l’atelier restent disponibles dans **Paramètres → Présentation des documents**. L’import de polices personnelles ou d’un document Word complet n’est pas inclus. Les montants sont calculés par l’application ; le certificat annuel officiel garde sa présentation réglementaire.

## Périmètre

Préversion Windows x64 en préparation, pas encore publiée. L’identifiant `ch.helvichantier.desktop` et le schéma SQLite 59 sont conservés. Aucun nouveau paquet macOS, iOS ou Android n’est inclus.

La mise à jour utilise la signature Tauri/Ed25519 existante. Aucun certificat Authenticode n’est disponible : Windows peut afficher « Éditeur inconnu ».

## Validation avant livraison

Les parcours de préparation ont été vérifiés dans Edge et WebKit à 320, 390, 844 et 1 440 pixels de large. Les factures émises restent verrouillées. Les scénarios SQLite de paire acompte/solde et de reprise d’un ancien acompte passent. Les tests des huit variantes de police, les exports PDF et leur inspection visuelle passent.

La suite complète, le paquet final, la reprise d’un profil Windows 1.60 et les téléchargements publics seront consignés après vérification. Les essais navigateur utilisent une connexion simulée ; ils ne prouvent pas une installation physique ni une synchronisation entre deux appareils réels.
