# Zentra 1.88.1 — runtime performance

## Changes

- Group each freshly loaded company's document lines once, instead of scanning every line for every document. Indexes exist only during normalization; they cannot retain another company's data.
- Compute dashboard amounts and payment totals once per input snapshot. Issued/cancelled documents, credit notes, discounts, VAT, reversals and separate currencies retain their existing rules.
- Reuse bounded, locale-aware number/date formatter configurations. No customer data is cached in these formatters.
- Isolate the active timer from the main workspace render. Pause its interval when the document is hidden, and derive elapsed time from the clock on return.
- Run native workspace/state reads in a blocking worker, keeping the shared company operation lock. This follows [Tauri's command execution model](https://v2.tauri.app/develop/calling-rust/) and keeps large SQLite/JSON work off the window thread.
- Correct the dark-mode timer ribbon's text contrast, observed during the performance journey.

## Measured evidence (Windows, synthetic data)

`runtimePerformance.test.ts` calls the production workspace bridge and financial helpers with 1,500 documents of each of nine types, eight lines per document: 13,500 documents and 108,000 lines. Three runs before and after, median in milliseconds:

| Work | Before | After |
| --- | ---: | ---: |
| Normalize the workspace | 2,022.58 | 41.78 |
| Aggregate sales amounts | 60.66 | 0.96 |
| Format displayed amounts/dates | 268.18 | 6.42 |

All runs produced the same SHA-256 for the complete normalized workspace, totals and formatted labels: `78492c62b0d06d3ce31e3915418ba173f20526c10f6bbaf8f23072cacbfb1645`. This is a local comparison, not a platform-independent golden hash (locale/timezone output may differ).

The Edge/WebKit UI journey uses 1,500 invoices at 390 and 1,440 px. Timer-driven React work fell from about 6–12 ms per tick to less than 1 ms. Search text and focus survived timer updates; all four cases had no page errors or horizontal overflow. These are browser/harness timings, not physical-device or cold-launch measurements.

## Validation

- Frontend suite: 210 files, 1,669 tests passed.
- Final affected tests: financial parity across four languages, snapshot isolation/order, large-company benchmark, release notes — six tests passed.
- TypeScript, production frontend build and opening-bundle audit passed. Heavy optional features remain deferred; 142 local assets verified.
- Native builds and installation checks are separate release gates. Do not infer their success from frontend tests.

Account credentials, network requests, sync frequency, mutation handling, business rules and entitlement checks are unchanged. A successful synthetic test does not establish actual multi-device synchronization or network login latency. The changes remove measured local work; server/network latency remains dependent on the connection.

Local reproducible evidence: `desktop/.qa/runtime-speed/{before,after-final,ui-before-timer,ui-after,ui-confirmed}.json`; test/build logs in `outputs/runtime-speed-{tests,build}.log`. These generated files remain outside source control.

## Native release evidence

Application source: `4921d40e3dae221c3db90d7c353841440e687129`. CircleCI jobs 104 (Windows), 105 (Apple) and 106 (Android) succeeded. Apple artifacts include 121 selected native tests passed (two pre-existing tests ignored) and five successful iPhone simulator navigation tests. Mac launch/relaunch and SQLite integrity were verified in a disposable profile. Android arm64 alignment and the existing preview signing identity were verified; the IPA is unsigned.

Windows local launch was rejected by Code Integrity with error 4551 (policy `0283ac0f-fff1-49ae-ada1-8a933130cad6`). The isolated Windows installer check in CircleCI job 107 passed, including payload identity, launch, relaunch and SQLite integrity. Its verifier source is `129d008e7e3143f456f16fc848873fec0b763a75`; application bytes still come from job 104 and the application source above.

The 14 immutable release assets are published at https://github.com/leartshbj1/zentra/releases/tag/v1.88.1. Mac's updater is promoted to 1.88.1. Windows downloads are available, but its automatic channel and this PC's installation remain at 1.88.0 because of the observed execution block. No Windows security setting was changed. The updater's Zentra signature is not an Authenticode certificate. Mac remains ad-hoc signed and non-notarized; no physical mobile device or store publication is claimed.

The timer visibility journey additionally passed in Edge and WebKit: no React timer updates while hidden, correct elapsed time immediately on returning. Final UI confirmation observed timer work at approximately 0–1 ms per tick (browser clock resolution limits these measurements).
