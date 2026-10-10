# US Support — H2a mailbox connection and explicit reading

10 October 2026. Local, gated continuation of H1. Existing CH Support, native builds, hosted databases, subscriptions and public publication are outside this phase. No production migration or gate activation.

## Scope and sequence

1. Add a per-US-company Infomaniak connection, using the shared fixed-origin transport and AES-GCM primitive. The new credential domain includes organization, registry workspace, connection and revision. Never borrow a legacy Support workspace or persist the API key in plaintext.
2. Add owner/admin connect/disconnect commands with expected revision, immutable sanitized receipts, exact retry after lost acknowledgement and CAS. Replacing/disconnecting purges the obsolete encrypted secret; immutable history contains no secret. Members can read sanitized connection metadata only.
3. Read a bounded page of recent messages only on an explicit owner/admin action. No background mail read, acknowledgement, import, classification, routing, automated workflow or financial write. A separate intake phase must compose H2 authority checks into existing original-upload checkpoints before enabling import.
4. Integrate the four-language light/dark panel into the existing US workbench behind a new default-closed gate. Retain H1's honest registry-only limitation when H2 is disabled.

## Contract

`UsMailboxContext` is schema 1, fresh H1 authority plus the actual immutable H1 workspace ID. Every operation checks current membership, owner, paid Gestion+Support on the same invoice/period, supported native session, registry, gates and role before/after awaits. Neither sender, message, email address nor body selects a tenant.

Public commands are exact objects: schemaVersion, requestId, expectedRevision, action; connect additionally email and token. Server-only connect fields are token SHA-256, generated connection UUID, provider, mailbox/folder IDs, AES-GCM ciphertext and verifiedAt. Command hashing includes organization/actor/action/expectedRevision/email/token SHA-256, and excludes generated IDs, ciphertext IV and time. Exact replay returns the current head plus historical receipt, never resurrects a replaced connection.

GET projection contains schemaVersion, organizationId, userId, role, workspaceId, revision, canManage and connection `{id,provider,email,verifiedAt}` or null. It excludes provider IDs, token digest and ciphertext. POST returns projection, sanitized receipt and replayed flag.

Explicit messages GET accepts only offset, integer 0..200 in multiples of 20. Fixed recent window: 30 days before connection verification. Provider limit is 20 threads, not 20 messages; reject malformed/oversized pages above 100 references or duplicate UIDs rather than silently dropping messages. Each message DTO contains uid, observed version, subject, sender, receivedAt and supported attachment metadata; no HTML/body, arbitrary URL or credential. Result includes complete scope, connection ID/revision, offset and nextOffset (or null). This observed date version is not a content-integrity guarantee. No source ingestion is enabled in this phase.

## Storage and safety

Additive D1 migration 0094 only: mutable CAS head; immutable connection descriptors and command receipts; separate credential rows allowing only first insertion and non-null to null purge. Corroborate H1's real SQL admission view and registry. Missing migration fails closed. No PostgreSQL schema changes, cross-store atomicity or RLS bypass claimed.

Gate: `INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED`, plus H1/Core/ERP gates. Existing `SUPPORT_ENCRYPTION_KEY` is server-only; distinct authenticated context prevents legacy/cross-company substitution. Closed public error vocabulary and diagnostics contain only operation/code/status. Reads and writes have per-company/actor rate limits.

## Verification and rollback

Real local SQLite chain 0000..0094; isolation, roles, paid-period changes, sessions, concurrency, immutable history, purge and lost acknowledgement. HTTP/fake provider tests: fixed endpoint, bounds, no automatic effects, revoked authority at awaits, scoped ciphertext and metadata-only member access. UI transport and rendering tests in FR/DE/IT/EN; bounded desktop/mobile visual review when runtime is available. Global typecheck, changed typed lint, brand check and production build; selected CH/US regressions.

Rollback: close H2 gate and revert application commit; retain registry/history. Never delete tables/data or move hosting. Deliver eight sections with exact commands/results and remaining experimental work. H2b intake, H3 classification/delegation, hosted staging and native distribution remain open.
