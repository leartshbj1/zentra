# US regulatory gates — research checkpoint

Primary sources reread on 8 October 2026. This is an engineering decision record, not exhaustive legal advice, an audit of a customer's tax position, or a claim of US GAAP certification. The Swiss edition and its retained data are unaffected. No production configuration is changed by this document.

| Verified source | Finding relevant to the design | Engineering decision and remaining validation |
| --- | --- | --- |
| [IRS Publication 538, Accounting Periods and Methods](https://www.irs.gov/publications/p538) | Accounting methods must be consistent; changing an established method generally requires approval. Cash and accrual are distinct. | Never toggle the basis of a populated book or reinterpret historical entries. Corrections and reversals retain their history. Tax-method eligibility and change procedures require a qualified review; the software does not file Form 3115. The page is the 2022 publication, read today, not a claim that its dated thresholds remain current. |
| [IRS Employment tax recordkeeping](https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-recordkeeping) | Employment-tax records have a specific retention obligation, including at least four years after the relevant fourth-quarter filing. | Do not apply a generic short deletion timer to financial or employment data. US payroll is not silently enabled by US invoicing or the Swiss payroll module. A retention schedule must distinguish record families and jurisdiction before production activation. |
| [Streamlined Sales Tax state tables and linked revenue departments](https://www.streamlinedsalestax.org/state-tables) | Remote-seller requirements vary by state; the table links state guidance and includes dated changes. | No universal threshold, national flat tax, or embedded exhaustive rate table. An actual configured tax provider must determine a supported transaction; a professional validates nexus, registrations, classifications and exemption evidence. State-specific guidance must be reread for the seller's actual jurisdictions. |
| [FTC Protecting Personal Information: A Guide for Business](https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business) | Minimize collected personal data, protect retained data, and plan for security incidents. | Keep private fiscal facts and credentials out of public readiness, document projections and diagnostics. Separate authenticated company access, retention and incident response. This is guidance, not a declaration that every privacy law applicable to a US customer has been reviewed. |

## Current release boundaries

- The US journal engine validates balanced entries and preserves posted history. Passing deterministic tests is not an accountant's certification or proof of tax-return suitability.
- A public `ready_test` value is an expiring interface hint. It is never authority to issue, calculate, post, send an e-mail, select an alternate company, or spend money. The protected server repeats admission and exact financial checks.
- Provider calculations must be observed in a separate TEST merchant scope. A declared owner status, a registration-shaped JSON object, an API key prefix or an SDK header alone cannot establish a real tax configuration.
- The initial fiscal vertical supports confirmed service classifications and exclusive prices. Goods/shipping fees, exemptions, inclusive prices, fractional provider quantities, credit/refund tax transactions and remittance remain explicit extensions. They are not replaced by a zero amount or a guessed code.
- Customer invoice payments and Zentra SaaS subscriptions remain separate. A platform merchant/Connect model needs its own responsibility, KYC, authorization and legal review before customer money is routed. No USD price is created arbitrarily.
- Supabase/hosting location, US privacy obligations, sub-processors, international transfers, storage retention, restore tests and a qualified accounting/tax review remain required before a public US pilot with real business data. No data-region move or production migration is approved by this research.

## Acceptance for the next observed pilot

Use fictional company and customer records. Preserve exact country/configuration/actor/version scope, provider request key and document dates. Record an authenticated TEST account, actual configured origin and current registrations, canonical classification, exact calculation breakdown, balanced journal, Letter PDF and recovery of the same receipt after a lost response. Then test hosted authorization, concurrent roles/workspaces, reconnection, storage restoration and each signed native build separately. Keep measured results separate from simulated tests.

The full international objective is still active. This checkpoint neither activates US production nor narrows the requested ERP to the first service-invoice path.
