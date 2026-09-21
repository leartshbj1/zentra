# Infomaniak connection replacement — 2026-09-21

New connections default to IMAPS on the fixed official endpoint mail.infomaniak.com:993. The user enters the full mailbox address and its dedicated mailbox/application password, with help linking to https://config.infomaniak.com/. Existing API connections remain supported; the wizard keeps that mode inside optional help.

## Read-only transport

- Verified TLS 1.2 or higher, fixed destination, bounded connection and command timeouts.
- ImapFlow EXAMINE/readOnly and BODY.PEEK; no Seen flags, STORE, MOVE, DELETE or SMTP operations.
- Password encrypted by the existing per-workspace/per-connection secret envelope. Raw protocol logging disabled. Provider errors converted to safe French messages.
- UIDVALIDITY checked on every connection. New connections start at UIDNEXT. Reconnecting IMAP preserves the initial UID; switching from API preserves tickets and starts new mail reception at the switch.
- Bounded 20-UID windows, stable external identifiers and existing receipt/document deduplication.
- One IMAP session per sync, always closed. MIME bytes stay transient, attachment reads reuse the current message. Messages over 12 MiB and attachments over 6 MiB require manual import and display an actionable error.

## Verification

- TypeScript check and production build passed.
- 155 Support/supplier-inbox tests passed, including MIME extraction, UID windows, encryption, reconnect, migration from API, deduplication and safe failures.
- Real TLS/IMAP greeting and CAPABILITY exchange with Infomaniak succeeded inside the local Cloudflare Workers runtime, without transmitting credentials.
- Connector assets and simplified form checked on desktop and 390/320 px mobile layouts; image assets load, dialog content has no horizontal overflow.

The mailbox still needs its password entered in the production form. A greeting/capability exchange does not prove successful login or real invoice delivery. Do not enable SUPPORT_MAIL_BACKGROUND_ENABLED until a scheduler run and the real mailbox-to-Gestion invoice flow are verified.
