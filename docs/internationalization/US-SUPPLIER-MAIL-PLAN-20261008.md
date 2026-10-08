# Zentra US — supplier mail to approved accounts payable

Base web `1e100d26f17594c5bfa62d24c151b60372856d38`. Previous goal turn made verified progress: bank source committed and targeted PostgreSQL/browser/Swiss checks completed. Public menu and native source remain separate and preserved.

Implement the next real workflow in the same ERP: literal text from an incoming vendor document, candidate-only Jev extraction in English with US dates and exact USD integer strings, a durable company-scoped proposal, explicit human review, then the existing vendor bill and accounting delta. The original Swiss invoice extractor, VAT rules, historic books and subscriptions remain unchanged.

The US proposal is not a certified tax determination, an automatic payment or an approval. Printed purchase tax is reviewed as part of purchase cost, not Swiss input VAT. Missing or contradictory currency/dates/totals require correction; missing source values never become invented zeroes. New vendor addresses are not fabricated from sender names. An existing vendor must be verified, or created through the existing authorized ERP surface before bill approval.

Proposal source and approval persist separately alongside book schema4. Approval uses one PostgreSQL transaction for proposal CAS, existing ERP commit, audit and exact receipt. Auth, workspace, current captured capability and US module entitlements are checked before every sensitive operation and after awaited work. Support mail delegation is server-owned; imported document text cannot grant membership, consent, workflows or modules. Human approval is explicit and remains auditable; the existing manual-entry record is not re-labelled as an autonomous financial decision.

Feature gates remain closed by default. Generate additive SQL through the pinned Supabase CLI and test disposable local PostgreSQL, source/domain/HTTP and browser journeys. No hosted migration, real message, API charge, subscription alteration or US deployment is performed without the required explicit approval. The pilot's raw-file archival, production mailbox delegation and native surface must be reported at their actual implementation and test scope.
