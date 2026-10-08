# US — sales and portable exports

Base: `7ae938d526cf09110967fabfd0d67154c5d0728f`. This additive phase follows the audited shared architecture and the validated purchasing schema negotiation. It changes the isolated international checkout only. Production, existing CH/native releases, Stripe prices and historical migrations remain outside this phase.

## User journey

Expose persisted invoices and their exact balances, record previously completed partial payments through the existing authorized ERP command, and show the five existing accounting reports. Build authorized JSON, printable HTML, genuine PDF and CSV exports from one validated durable snapshot. Invoice issuance remains unavailable in the real binding until a trusted tax-provider connection exists; a private test issuer is used only in synthetic browser tests.

Document exports reuse archived invoice seller/tax/configuration facts and persisted numbering. A vendor-bill export is an internal entry sheet, not a replacement for the supplier's original invoice. Report exports preserve accounting basis, company identity, date range and durable revision. No export mutates the book or reserves a number.

## Boundaries

Every read/export uses current US workspace membership, expected user, product entitlement, feature flags and schema negotiation. Authorization is checked again after rendering/font/hash waits. Public snapshots exclude private tax identifiers and proof payloads. Rendering uses fixed licensed fonts without network or filesystem access at request time, limits rows/pages/output size, and rejects unsupported glyphs rather than silently replacing them. Downloaded files are local copies and cannot be revoked retroactively.

No CH archive retention policy or legacy archive table is reused for US. This phase introduces no migration, no remote archive guarantee and no banking/payment execution. Integration with the native editions, a real fiscal provider, staging PostgreSQL and commercial US billing remain separate milestones.

## Planned validation

Run the previous 78-file international/CH regression selection plus the new sales/export tests. Verify exact money, archived identity, balanced reports, unsupported inputs, tenant/role/session revocation, CAS/exact retry, PDF text/page geometry/pagination, browser downloads, four languages, two themes, narrow screens and 200% text. Typecheck, type-aware lint, production build, source hash stability and historical migration equality complete the local evidence. None of these substitute for hosted staging, physical devices or production multi-device testing.
