# Zentra 1.69.1 — account, domain and company synchronization

Native source: `592b58baa3740a2df6d412c39778ee3478661100`.
Base synchronization/account release: `943b3663db804a30df0799e29f37f5e83f91d3bf` (1.69.0).
Production website source for domain migration: `1f6c31e4a99f95af9c9455a6cfe7e6218b56a99b`, Sites version 152, environment revision 29.

## Behavior

New native account, verification and licence-refresh requests use `https://zentraapp.ch`. Previously protected pending authorizations retain their code and normalize only the exact former first-party hostname. Customer navigation on former/www hostnames redirects to the canonical domain without losing its path/query. API calls and already-issued PKCE reset callbacks remain compatible; no bearer credentials are redirected to another host.

Invitation links are generated on the canonical origin. Stripe's existing live webhook now uses `/api/stripe/webhook` on zentraapp.ch, preserving its signing secret and event set. The existing classic product, merchant-facing account name, public merchant name and statement descriptor are Zentra. Prices and existing subscriptions were not changed.

Paid subscription activation binds the authenticated checkout account to its company membership and subscription. Return-page activation and webhooks are idempotent. Signing in and approving the device replaces manual token copying for the normal customer flow. No live payment or subscription was purchased during verification.

Committed business changes wake the native synchronization scheduler; authenticated private Supabase revision notices accelerate reception. The server rereads the durable revision after joining the notification stream. Incoming replacement waits while forms are being edited. Full company snapshots remain guarded by compare-and-swap revisions: two dirty concurrent copies are not automatically merged and may require conflict resolution.

## Verified

- Native account tests: 13 passed, including former-link normalization and rejection of impostor hosts, invalid ports and credentials. Native rustls licence-refresh probe passed against zentraapp.ch.
- Domain navigation/origin tests: 21 passed; cloud access/release history UI tests: 10 passed; TypeScript and production builds passed.
- Earlier synchronization validation: 6 Rust collaboration tests and 15 frontend scheduler/realtime tests passed; website account/payment/realtime suite 125 tests passed plus focused final regressions.
- Actual gateway authenticated watch returned HTTP 200 with `realtime:true` on zentraapp.ch, preserving the current organization revision. Separate private Supabase canary subscribers both received a revision notice in 330 ms; no company document was changed.
- Windows 1.69.1: six isolated packaged runs passed (fresh/restart, seeded 1.61.0, replacement/restart). Business rows, attachments, accounting balance, protected installation identity and SQLite integrity were preserved. This tests the actual binary, not a complete NSIS installation into the user's profile.
- Windows updater signature independently verified; immutable installer, signature, checksum and manifest downloaded and checked. Windows channel promoted to 1.69.1 with 60-second cache; shared historical channel unchanged.
- Physical-device iPhone ARM64 IPA metadata and source verified. Four native Liquid Glass tests passed. No personal owner licence embedded. Requires Apple signing before installation; no physical iPhone installation was performed.
- Android ARM64 APK signed with the existing durable preview identity; certificate and 16 KiB alignment verified. The binary contains the canonical licence-refresh URL. No physical Android installation was performed.
- Twelve public pages returned 200 without the former visible brand/domain or the Sites sign-in button. Former account, invitation and device links redirect to the same path/query on zentraapp.ch. Browser account session remained usable.
- SMTP recovery email received in Gmail from info@zentraapp.ch; SPF, DKIM and DMARC passed. No password changed.
- Live Stripe Checkout configuration verified for 49/59/89 CHF, then sessions expired without payment. A genuine non-payment Stripe event was delivered to the canonical webhook. Both empty technical canary customers were removed after delivery verification.

## Artifact fingerprints

- Windows installer: `11128B3A2C194C5AAA88D7B915B2FE23C15042D9446B4ED7313BB528A1488ACB`.
- Windows application: `1420A3BF1CC7E76128A7D54A82C7FAD7598DFA845470F60762325AD172B62AB0`.
- iPhone IPA: `093FD75BDFB3A276111D5E77EDB00B04A329444CB0A1038011C26F2D03A7AF7E`.
- Android APK: `0DC4C11E7EFDA7AD7EBF8BB02555575E33CA90EFCFFF20AB62EB132151E0A635`.

Windows installer is not Authenticode-signed. Android is a signed preview build. Apple Developer distribution/notarization remains unavailable; an updater signature is not Apple notarization. Production Stripe account readiness and configuration were verified, but a paying customer's end-to-end purchase has not been exercised with a real charge.

Evidence is in the ignored `.qa` logs/proofs; no secrets, auth tokens, payment data or company contents are included in this report.

## Final platform and realtime verification (15 September 2026)

The six native collaboration tests were rerun against 1.69.1 and passed, including an actual invoice issue and partial payment across three isolated company copies. The totals, unpaid amount, immutable document creator and balanced accounting entries matched. The test transports real snapshots locally; it is not a physical three-device production network trial. Fifteen scheduler/realtime lifecycle tests also passed again.

macOS cloud build 6aa89a94abc9065737cee8ce completed successfully from the exact native source above. The archive contains Intel and Apple Silicon executables, macOS 12 minimum, the correct updater channel/key, and an ad hoc code signature verified on the build Mac. Six company-access cases, three mobile gesture/zoom/safe-area viewports, invitation/rejoin cases, and 138 appearance checks passed in WebKit. No low-contrast remnants were reported by those checks. No installation on a customer's physical Mac was performed.

Mac DMG SHA-256: `77B1DBE82F996D4E6CA1B0FD6E67FB3B6E064D8C6EFCF9620654E3872BA70B48` (50,277,532 bytes).
Mac updater archive SHA-256: `7CF93EF2195839D569F578ACC7B3D7E05907555BC91667147E15D3C9BFA5F751` (50,251,525 bytes).
The updater archive was signed with the existing key and independently verified. Both public artifact stores were checked against these hashes. The ordinary Windows and Mac updater URLs now both return 1.69.1 with max-age=60. The historical shared manifest remains 1.46.1.

Windows, macOS, iPhone and Android 1.69.1 assets are published at https://github.com/leartshbj1/zentra/releases/tag/v1.69.1 and linked from https://zentraapp.ch/download. The website also explains automatic company sharing and account-based licence activation rather than the previous project-only/manual-token guidance.

Final website source: `b56bb76d16e0d76ee564e849f7732fefd8f56416` (saved Sites version 155). This final copy update removes obsolete statements that only project files are shared or that customers must copy a licence token. The earlier domain migration remains deployed with compatible redirects.
