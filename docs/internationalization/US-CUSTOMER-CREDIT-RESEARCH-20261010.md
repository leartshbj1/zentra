# US customer credits — recherche et critères d'admission

Date de vérification : 10 octobre 2026. Périmètre : worktree `international-site`, code observé à `04f8325`. Cette note distingue les faits documentés, les constats de code et les propositions d'architecture. Elle ne constitue ni un avis fiscal ni une attestation US GAAP.

**Décision recommandée pour le prochain lot : préparer un avoir, sans effet financier.** Ne pas émettre un avoir comptable, diminuer le solde dû, créer un crédit utilisable, rembourser ou ajuster une taxe avec le socle actuel. Une préparation peut sélectionner une facture et des lignes, expliquer le motif et présenter une proposition à valider. Elle doit clairement rester une préparation.

## 1. Ce qui est effectivement présent

| Constat vérifié dans le code | Conséquence pour la prochaine verticale |
| --- | --- |
| [`ErpSchemaVersion`](../../lib/international/erp-schema-capability.ts) accepte 1–4 ; [`ErpState` et `ErpCommand`](../../lib/international/runtime-types.ts) n'ont aucun document d'avoir, allocation de crédit ou remboursement client. | Ne pas ajouter quelques champs financiers à un état v4 et prétendre prendre en charge un schéma suivant complet. |
| [`IssuedInvoice`](../../lib/international/invoicing.ts) conserve le snapshot émis et des paiements positifs. `invoiceBalance()` soustrait seulement les paiements. | Un avoir ne peut être un paiement négatif, une réécriture de facture ou un changement local du dashboard. |
| [`UsTaxInvoiceTestGateway`](../../lib/international/us-tax-invoice.ts) expose `verify()` et `calculate()` ; le [`gateway concret`](../../lib/international/stripe-tax-test-gateway.ts) n'expose que settings, registrations, calculations et catalogue. | Aucun enregistrement ou ajustement de Tax Transaction n'est disponible. |
| [`StripeTaxPrivateProof`](../../lib/international/stripe-tax-calculation.ts) contient `mode: 'test'`, `calculationId` et des lignes de calcul. L'assessment utilise ce calculation ID comme référence. | Une preuve `taxcalc_…` n'atteste pas l'existence d'une vente fiscale enregistrée `tax_…`, ni d'un paiement remboursable. Ne pas fabriquer cette relation depuis la seule référence. |
| [`runtime-validation.ts`](../../lib/international/runtime-validation.ts) reconstruit les factures, paiements et écritures depuis leurs sources et exige l'égalité exacte du plan avec le starter chart. | Les futures sources d'avoir/remboursement et le plan comptable nécessitent une évolution cohérente du replay ; ajouter globalement un compte invaliderait les historiques. |
| [`postCustomerPayment()`](../../lib/international/accounting/postings.ts) répartit les encaissements cash au prorata cumulatif du net et de la taxe de la facture d'origine. | Un avoir visant certaines lignes change les proportions restantes : le moteur actuel ne peut pas être réutilisé sans politique et replay nouveaux. |

Le blocage n'est donc pas uniquement un bouton manquant. Il manque le contrat financier, la politique comptable, la transaction fiscale d'origine et le cycle de reprise. Les factures TEST existantes restent des factures du pilote ; leur existence ne permet pas d'inférer un flux fiscal ou bancaire live.

## 2. Avoir, crédit client et remboursement : trois objets

**Fait fournisseur, pas règle comptable universelle :** Stripe Invoicing permet de réduire une facture finalisée par credit note tout en conservant le document d'origine. Sur facture ouverte, l'avoir réduit le dû ; sur facture payée, la restitution peut être un remboursement, un crédit utilisable plus tard ou une opération externe enregistrée. Créer un avoir ne signifie donc pas toujours déplacer de l'argent. Stripe recommande les lignes liées à la facture plutôt que des lignes libres pour conserver la traçabilité. Son API limite aussi le mélange quantité/montant sur une même ligne au fil des avoirs. Ces comportements ne s'appliquent automatiquement qu'aux objets Stripe Invoicing concernés. [Stripe, credit notes programmatiques](https://docs.stripe.com/invoicing/integration/programmatic-credit-notes).

**Distinctions proposées pour Zentra :**

- `CreditPreparation` : intention révisable, sans créance réduite, sans numéro d'avoir émis, sans crédit client disponible et sans écriture.
- `IssuedCustomerCredit` : document financier immuable lié à une facture, avec lignes, motif, politique et preuves admises ; son affectation doit être explicite.
- `CreditAllocation` : application d'un crédit à une créance déterminée, dans la même entreprise/devise/client, sans nouvel encaissement bancaire.
- `CustomerRefund` : mouvement de restitution distinct. Séparer demande, exécution chez le prestataire et règlement observé ; pour un paiement externe, distinguer l'enregistrement d'un remboursement déjà effectué de son déclenchement.

Un encaissement original ne doit pas disparaître lorsqu'il est remboursé. Un avoir ne devient pas un « paiement reçu ». Une facture réglée par crédit doit rester distinguable d'une facture encaissée. Aucun de ces objets ne doit modifier l'abonnement SaaS Zentra.

## 3. Stripe Tax : calcul, transaction et reversal

**Fait vérifié :** dans l'intégration custom, le calcul détermine un montant ; une Tax Transaction distincte enregistre l'opération pour les rapports. Le guide demande de conserver la transaction d'origine pour les restitutions. La création depuis un calcul est limitée par son expiration, actuellement décrite à 90 jours ; cette fenêtre ne constitue pas une permission de recréer rétroactivement une vente pour rendre un avoir possible. [Stripe, intégration custom](https://docs.stripe.com/tax/payment-intent/custom#tax-transaction).

**Inférence d'admission pour le projet :** faute de transaction d'origine attestée dans le bon compte et le bon environnement, refuser toute opération annoncée comme un reversal fiscal. Ne pas réutiliser `calculationId`, ne pas créer une transaction artificielle au clic sur « avoir », ne pas recopier une transaction du compte SaaS. L'événement déclencheur légal et le processus de rattrapage d'une vente historique doivent être validés avant tout nouveau port financier.

Les modes d'intégration ont des comportements différents :

| Intégration documentée | Comportement à préserver, sans extrapolation |
| --- | --- |
| Stripe Invoicing avec Stripe Tax | Les remboursements/credit notes de ces factures déclenchent des ajustements automatiques. Un remboursement associé à un avoir échoué ou annulé ne règle pas la dette envers le client, même si la réduction fiscale liée à l'avoir demeure. Un remboursement et l'avoir correspondant ne doivent pas produire deux réductions. [Guide Invoicing](https://docs.stripe.com/tax/invoicing/refunds). |
| PaymentIntent avec intégration Tax basic/simplified | Stripe gère les transactions et reversals des remboursements liés, par répartition flat amount. Les disputes n'entraînent pas automatiquement de reversal. Calcul et PaymentIntent doivent appartenir au compte approprié. [Guide basic](https://docs.stripe.com/tax/payment-intent/simplified). |
| Tax custom ou paiement hors Stripe | Le système enregistre explicitement transactions et reversals. Un remboursement bancaire et son enregistrement fiscal restent deux étapes à rapprocher. [Paiements hors Stripe](https://docs.stripe.com/tax/off-stripe#reversals). |

Dans le flux custom/hors Stripe, conserver les identifiants de transaction et de lignes, les montants hors taxe/taxe, les signes attendus, la devise, le compte/mode, la référence unique et les opérations antérieures. Le guide documente actuellement jusqu'à 30 reversals partiels par vente. Un montant flat se répartit sur le reliquat des lignes/livraison ; il ne prouve pas que la bonne ligne métier est remboursée. **Un reversal `full` ne neutralise pas les reversals partiels antérieurs** : traiter leur compensation ou préférer une stratégie de reliquat explicitement testée pour éviter le double ajustement. Les corrections de taxe seule peuvent produire des rapports inadéquats ; ne pas les activer par simple prorata local. [Stripe, reversals hors Stripe](https://docs.stripe.com/tax/off-stripe#reversals).

Pour un futur adapter, vérifier la forme exacte et la version API choisie avant développement. Cette note ne constitue pas un schéma de requête exécutable ; aucune mutation Stripe n'a été essayée.

## 4. Cash/accrual : ce que la recherche permet et ne permet pas de décider

L'IRS décrit la méthode cash par les revenus effectivement ou constructivement reçus, et l'accrual par les revenus gagnés ; la méthode doit être cohérente et certains changements requièrent une autorisation. Ce sont des règles de fiscalité fédérale, pas un moteur de conformité pour toutes les entreprises ou une règle de sales tax par État. Ne pas transformer le paramètre `basis` en sélecteur de calendrier de sales tax. [IRS Publication 538, version 01/2022 actuellement publiée](https://www.irs.gov/publications/p538).

Les instructions Schedule C définissent les retours et allowances séparément des recettes brutes. Elles reconnaissent des restitutions en argent ou crédit ; elles ne fournissent pas une règle universelle pour la date fiscale de chaque crédit reportable de notre ERP. Leur périmètre Schedule C doit rester explicite. [IRS, instructions Schedule C 2025, ligne 2](https://www.irs.gov/instructions/i1040sc).

La Publication 334 distingue aussi un retour/allowance d'une créance irrécouvrable : en cash, une somme jamais incluse au revenu ne devient pas une déduction de bad debt simplement parce qu'elle ne sera pas encaissée. Elle précise que le traitement fiscal du revenu peut différer du traitement financier. Ne pas détourner un avoir en bad debt ou appliquer aveuglément l'exemple des remises fournisseur à une remise accordée à un client. [IRS Publication 334 2025](https://www.irs.gov/publications/p334).

Le règlement fédéral actuel prévoit, pour les rebates/refunds relevant de l'economic performance, un paiement au bénéficiaire pouvant aussi prendre la forme d'une réduction du prix d'une fourniture future. Son application dépend du régime et des exceptions ; il ne permet pas de considérer n'importe quelle ligne « crédit client » comme un paiement. Un avoir émis, une réduction de créance, une restitution et une compensation future doivent donc avoir des dates/provenances distinctes. [26 CFR 1.461-4(g)(3), eCFR](https://www.ecfr.gov/current/title-26/section-1.461-4#p-1.461-4(g)(3)).

À titre de limite documentaire, Rev. Proc. 2011-17 expose une méthode particulière pour les gift cards remis contre retours de marchandises par certains détaillants en accrual. Elle ne valide pas les crédits génériques d'un prestataire en cash. Les références historiques et procédures de changement qu'elle contient ne sont pas une instruction de paramétrage actuelle ; leur applicabilité n'est pas tranchée ici. [IRS, texte de 2011](https://www.irs.gov/irb/2011-05_IRB).

**Options d'architecture à faire valider, aucune retenue comme règle fiscale acquise :**

| Situation | Politique possible pour un futur moteur | Ce qui bloque aujourd'hui |
| --- | --- | --- |
| Cash, aucun paiement reçu, remise avant paiement | Réduire la créance opérationnelle par avoir admis ; reconnaître ensuite les montants réellement réglés sur la base ajustée. Pas de revenu ou cash fictif à annuler. | Nouveau modèle d'avoir, détermination de la taxe ajustable et allocation des paiements. |
| Cash, paiement partiel | Séparer la part réduisant le restant dû et une éventuelle restitution/crédit du montant déjà reçu. Ne pas choisir silencieusement « impayé d'abord », « payé d'abord » ou prorata. | Politique de répartition par ligne et de reconnaissance, conservation des revenus/taxes déjà reconnus. |
| Cash, facture payée, avoir émis sans restitution | Conserver l'obligation envers le client et distinguer sa reconnaissance financière de son effet fiscal ; ne pas créer une sortie bancaire. | Date et traitement d'un crédit reportable, compensation future, expiration et corrections non validés. |
| Cash, remboursement effectif ou utilisation future du crédit | Événement de règlement séparé, avec preuve et date. Éviter de réduire le revenu à l'émission puis une seconde fois au règlement. | Politique fédérale/État et comptable applicable, flux prestataire/externe, période. |
| Accrual, créance impayée | Proposition financière : contre-revenu et taxe ajustable admise contre réduction d'AR. | Plan versionné, événement fiscal autorisé, distinction livre financier/déclaration fiscale. |
| Accrual, facture déjà payée | Proposition financière : crédit/passif client séparé ; restitution ultérieure contre cash, sans seconde réduction du revenu. | Choix de présentation AR négatif ou passif distinct ; traitement fiscal pouvant différer du livre financier. |

Les propositions d'écritures ne sont pas des règles US GAAP garanties. Ne pas ajouter automatiquement une écriture de stock/COGS pour un retour tant que le mouvement physique et la politique d'inventaire ne sont pas modélisés. Les années antérieures, taxes seules, frais de restocking, chargebacks, dettes abandonnées et gift cards restent hors du premier périmètre.

## 5. Exemples d'État : raisons de ne pas généraliser

- **Californie seulement :** Regulation 1655 conditionne l'exclusion de certaines marchandises retournées et encadre les frais retenus pour rehandling/restocking. Elle ne justifie pas un bouton universel « remboursement partiel = même pourcentage de taxe récupérée ». [CDTFA Regulation 1655](https://cdtfa.ca.gov/lawguides/vol1/sutr/1655.html).
- **New York, avis de 2009 limité à ses faits et au demandeur :** TSB-A-09(29)S examine une restitution diminuant avec le temps et lie l'ajustement à la partie de transaction réellement défaite et à la taxe restituée. Ce n'est ni une règle actuelle exhaustive de New York ni une règle nationale. [Avis officiel](https://www.tax.ny.gov/pdf/advisory_opinions/sales/a09_29s.pdf).

Avant une émission effective, faire confirmer juridictions, type de bien/service, raison de l'ajustement, preuve de restitution/compensation, frais éventuels, période de déclaration et procédure de correction. Une réponse technique acceptée par Stripe ne constitue pas cette validation.

## 6. Prochain lot autorisable sans effet financier

Proposition technique incrémentale, distincte du futur schéma financier :

1. Contrat privé autonome de préparation, lié à l'entreprise et à une vraie facture US du runtime. Conserver l'ERP revision observée, l'identité/empreinte exacte de la facture et de ses lignes, l'auteur/date, le motif et les montants proposés en minor units. Ne pas prétendre que la facture possède une propriété `revision` inexistante.
2. Autorisation fraîche et Gestion admis côté serveur ; proposer le même périmètre financier de lecture/préparation pour éviter de donner à un membre commercial un accès nouveau. Aucun identifiant client, facture ou preuve d'un autre tenant accepté. Ce choix d'accès est une politique produit, pas une obligation réglementaire.
3. Afficher les montants de taxe historiques uniquement comme information de la facture ; les éventuelles réductions proposées restent non validées. Statut explicite `tax_adjustment_unavailable`/préparation, sans badge « taxe remboursée ».
4. Source relue avant enregistrement/confirmation interne. Une confirmation interne signifie uniquement « proposition relue » ; aucun numéro officiel, aucune emission, allocation, contrepassation, caisse ou statut paid modifié. Une nouvelle préparation ne réserve pas définitivement le plafond d'avoir financier.
5. Aperçu/export clairement marqué « Préparation uniquement — avoir non émis. Aucun solde ni remboursement modifié. » Pas de document présenté comme avoir officiel. Données privées autorisées seulement, pas d'EIN ou de preuve fiscale interne intégrale dans l'export.
6. Pas de migration financière v5 partielle, modification de starter chart, recours au manual journal pour contourner les sources, nouveau compte marchand ou accès production.

## 7. Conditions avant tout effet financier et tests à prévoir

**Bloquer l'émission/allocation/remboursement** tant qu'une condition manque : contrat versionné complet et replay ; plan comptable historique compatible ; politique cash/accrual et périodes validée ; source fiscale admise ou cas sans ajustement démontré ; relation compte/mode/transaction/lignes prouvée ; plafonds et concurrence en base ; approbation/entitlement/permissions ; idempotence durable et reprise après résultat incertain. Ne pas interpréter une taxe historique zéro comme une preuve d'exemption ou une absence de configuration comme une taxe zéro.

Tests de la préparation : source absente/autre tenant/altérée, accès révoqué, source hors pagination, draft de facture refusé, sélection partielle/totale, calcul entier et arrondi, double soumission, source modifiée pendant la requête, export privé, libellés sans fausse émission. Vérifier surtout que ledger, compteurs financiers, factures, paiements, balances et reçus ERP restent strictement inchangés.

Tests futurs de finance : impayé/partiel/payé × cash/accrual × avoir partiel/total ; lignes taxable/exemptes/remisées et centime final ; paiements après avoir ; crédit appliqué une seule fois ; remboursement échoué/annulé ; plusieurs partial reversals puis clôture totale ; limite fournisseur ; non-proportionnalité fiscale ; périodes fermées ; concurrence avoir/paiement/refund ; réponse perdue et reprise exacte ; idempotence au-delà de la rétention fournisseur ; droits/tenant révoqués ; historique v1–4 et CH inchangé. Les refus de résultat incertain ne doivent pas inviter à créer une nouvelle opération et doubler les effets.

## 8. Méthode et limites de cette passe

Skills lus : `stripe-docs` et `stripe-best-practices`, avec références tax/security/billing/payments. Le CLI local 1.53.0 annonce 1.53.1 disponible : aucune mise à jour/install globale effectuée, aucun usage de ce binaire pour les recherches de contenu. Documentation Stripe consultée via l'outil officiel `search_stripe_documentation`, sans sélection de compte marchand. IRS, eCFR et autorités d'État consultés directement sur leurs domaines primaires. Les sources historiques sont identifiées comme telles ; aucun seuil fiscal ancien n'est repris.

Aucune clé consultée, API marchande appelée, sandbox créée, transaction simulée/réelle, migration ou déploiement effectué. Aucun test applicatif exécuté pour cette note ; la liste ci-dessus est un plan de validation. Le seul fichier créé par cette passe est cette note. La recherche ne décide ni une conformité fiscale nationale, ni l'éligibilité de chaque entreprise au cash basis, ni la politique d'un État non étudié.
