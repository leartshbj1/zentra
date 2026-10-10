# US sales orders - primary-source review, 10 October 2026

## Scope and implementation decision

This review supports an incremental commercial sales-order stage. It is not an exhaustive review of US contract, income-tax, sales-tax or accounting law, and does not certify US GAAP compliance. The initial order records an internal confirmation before any payment, delivery or service completion is recorded. It does not post to the general ledger, change customer receivables, calculate a final tax, collect money or promise legal enforceability. This is an **architecture boundary**, not a legal assertion that a sales order can never have tax or contractual consequences.

Existing source inspection: `invoicing.ts` distinguishes an estimate, issued invoice and customer payment. The invoice retains `sourceEstimateId` and `sourceEstimateRevision`. `accounting/postings.ts` posts an accrual invoice on the reviewed assumption that the invoiced revenue has been earned; it is not a contract-obligation or deferred-revenue engine. Therefore confirming an order must not call `postCustomerInvoice` or manufacture a `CustomerPayment`. Older snapshots, exports and CH contracts remain unchanged.

## Contracts and evidence: state-specific examples

New York UCC section 2-204 allows agreement for goods to be shown in different ways, including conduct. Section 2-201 has written-record/signature requirements, exceptions and quantity-related limits for certain goods contracts. The scope of article 2 is itself qualified, including hybrid transactions. These are **New York provisions**, not an assertion that every US services contract follows one federal rule. [NY UCC 2-204](https://www.nysenate.gov/legislation/laws/UCC/2-204), [2-201](https://www.nysenate.gov/legislation/laws/UCC/2-201), [2-102](https://www.nysenate.gov/legislation/laws/UCC/2-102).

**Architecture inference:** store the actual estimate revision, seller/customer/line snapshots, conditions, internal confirmer and instant. Do not label an internal staff confirmation as a customer signature or legally binding acceptance. Freeze confirmed facts; record a cancellation or explicit later revision rather than overwriting history. Contract modifications can have further requirements: New York section 2-209 is one example. [NY UCC 2-209](https://www.nysenate.gov/legislation/laws/UCC/2-209).

## Income recognition and advances

IRS Publication 538 distinguishes cash and accrual methods. It generally associates cash income with actual or constructive receipt and accrual income with the applicable earned-income/all-events rules. Advance payments have specific inclusion/deferral rules and eligibility/election requirements. This does not justify treating every receipt as an ordinary payment of an already earned invoice, or every order as revenue. [IRS Publication 538, Accounting Methods and Advance Payments](https://www.irs.gov/publications/p538).

**Architecture inference:** keep order, invoice, advance, payment, credit and refund as distinct events. A future advance workflow needs an explicit policy and review, not a dummy invoice or the current cash/accrual switch. Cancelling an unexecuted order must not delete an issued invoice, posted journal or payment. A credit document and a refund remain different records and effects.

## Sales tax: no invented final amount

The time of sales-tax liability cannot be inferred universally from invoice/payment dates. The California tax authority's annotation 495.0672 explicitly discusses that distinction for the sale addressed there. This is a **California authority/example**, not a complete timing rule for all jurisdictions or transactions. [CDTFA annotation 495.0672](https://www.cdtfa.ca.gov/lawguides/vol2/suta/495-0672.html).

New York's recordkeeping guidance calls for records identifying taxable/non-taxable items and separately stated tax due on applicable invoices/receipts. It does not establish one nationwide invoice schema. [NY Tax Department, Recordkeeping Requirements for Sales Tax Vendors](https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/record-keeping_requirements_for_sales_tax_vendors.htm).

**Architecture inference:** the initial order displays commercial amounts excluding tax, plus an explicit tax-pending status. Unknown tax is not a tax of zero or an exemption. Conversion to a real invoice must retain the existing current provider/configuration/location/classification checks. The exact order revision and source estimate revision stay in its provenance; an estimate or order is not a Tax Transaction, tax return or payment.

## Documents and future deliveries

IRS Publication 583 describes supporting documents used to substantiate books and returns; proof of payment alone does not establish deductibility. Preserve the commercial trail and distinguish supporting records from completed financial transactions. [IRS Publication 583, Supporting Documents](https://www.irs.gov/publications/p583).

For covered distance sales of merchandise, the FTC rule addresses shipment promises and delays, with consent/refund obligations. An internal order screen does not implement those duties. Do not present the first services-only pilot as a complete goods fulfillment/refund system or automatically promise shipment dates. [FTC, Mail, Internet, or Telephone Order Merchandise Rule](https://www.ftc.gov/legal-library/browse/rules/mail-internet-or-telephone-order-merchandise-rule).

## Verification checklist for this stage

- Confirmation changes commercial state only; journal, payments and customer receivables remain unchanged.
- Snapshot totals use exact minor units and the existing line rounding/discount rules; tax stays pending.
- Confirmation freezes source estimate revision and public party snapshots; later edits cannot alter the archived order.
- Internal author/date are identified as internal confirmation, not customer consent or certification.
- Concurrent conversion/replay cannot create a second invoice or bypass the existing one-invoice-per-source rule.
- Lost responses retry the identical command. Cross-company access, revoked access and stale revisions fail safely.
- Export validates strict private input, removes secrets/EIN/internal provider payloads, preserves US Letter and FR/EN/DE/IT labels, and does not call the legacy ERP snapshot v5 schema an order export.

Hosted rollout, real sales-tax transactions, advances, credit notes, refunds, recurring billing and fulfillment remain separate work requiring their own implementation and verification. No production changes were made for this research.
