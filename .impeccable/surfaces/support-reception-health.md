# Support reception health

Mode: Operate. Ordinary extension of the existing Support connection settings and administration, documented on 27 September 2026. Preserve the Zentra Studio world in `DESIGN.md`; no redesign, new world, concept seed or new token is introduced.

## Direction contract

THESIS: Read whether server reception is confirmed, identify a delay or failure, and know what to do next without leaving the existing Support screen.
OWN-WORLD: Existing white and pearl Support surfaces, green actions, compact text, thin borders and functional notices. The local failure treatment remains red. No added illustration, depth or motion.
STORY: Reception guidance leads into the server state, recovery instruction and last completed server passage. The mailbox's own last retrieval and error follow separately. Administration offers a read-only refresh before its existing configuration controls.
FIRST VIEWPORT: Keep the incumbent screen heading and composition. In administration the state follows the heading; in connection settings it stays with the existing reception guidance, which can be below the first viewport. Do not add a dashboard or promotional hero.
FORM: Code-led reuse of existing components and status treatments. Information and actions remain textual and in normal document flow.
FINISH: The narrow visual disposition is `ship` in `.qa/scheduler-health/finish-review.md`. Documentation preserves its evidence limits; it does not certify a live scheduler or a whole-product release.

## Implemented component reuse

`components/support/mail-reception-status.tsx` supplies the same readout to `ConnectionsPanel` in `panels.tsx` and `SupportAdministration` in `administration.tsx`. It uses the existing quiet metadata treatment for ordinary states, the existing notice treatment when attention is needed, and the existing error variant for failure. No stylesheet changes are required by this extension.

The readout contains a strong title, a short explanation and, when valid, a separate date. Its `role="status"` makes changes available as status announcements. The `<time>` carries the ISO value and displays the completed passage in French Swiss format and the Europe/Zurich time zone. Missing or invalid completion dates are omitted; the readout does not manufacture a recent passage from the time of a page refresh.

`SupportAdministration` reuses the shared outline `Button` for “Actualiser l’état”. The button changes to “Vérification…” and is disabled while the existing read operation runs. It reloads administration data without starting the worker. `ConnectionWizard` reuses the detail from `schedulerHealthCopy` inside its existing reception help; it gains no new screen or visual treatment.

The existing `support-small`, `support-notice` and `support-error` rules in `app/support/support.css`, with the Studio variables and overrides in `app/studio.css`, remain the implementation authority. The notice is a functional container, not a new generic card pattern. Existing responsive notice wrapping, button focus and reduced-motion behavior remain in force.

## State and product truth

The state wording is shared through `lib/scheduler-health-copy.ts`; server conditions belong to `lib/scheduler-health.ts` and the contract in `docs/SCHEDULER-HEALTH-20260927.md`.

| State | User-facing meaning and next action |
| --- | --- |
| Inactive | Reception depends on keeping Support open; closed-page reception is not active. |
| Unverified | No successful completed passage is confirmed; keep Support open. |
| Running | A first passage asks the user to keep Support open. Continued reception is claimed only when a recent successful passage also supports it. |
| Current | A recent completed passage supports “Traitement serveur vérifié”. |
| Delayed | Explain the delay, keep Support open, and contact Zentra if it persists. |
| Failed | Name the failed server treatment, keep Support open, and contact Zentra if it persists. |
| Unavailable | Explain that verification failed, keep Support open, and recheck on the next load. |

The compatibility fallback for older data with `background: true` but no known state says reception is configured and directs the reader to the mailbox's last retrieval; it does not say execution is verified. Server health is global to the shared worker. It does not prove delivery of an individual email, success of every mailbox, or empty queues. “Dernier passage du serveur” stays distinct from “Dernière récupération” and from a mailbox-specific error. Internal classification does not move, delete or mark provider mail as read.

## Evidence and limits

The supplied packet contains 16 captures in `.impeccable/review/scheduler-health/`, recorded by `.qa/scheduler-health/proof.json`: Chromium and WebKit, connection settings at 1440/current, 390/delayed, 320/failed, 390/inactive, 390/unavailable and 1440/unverified; administration at 390/current and 1440/failed. All recorded cases have no horizontal overflow and no JavaScript errors. The checking script also verifies a second mock administration fetch and focus on the refresh button.

These are local renders of the actual components using fictional data and mocked fetches. The fixture declares Arial rather than loading production Geist. The packet has no running-state or wizard screenshot and no live network, authenticated tenant, physical iPhone or native build proof. It reports 363 targeted tests, TypeScript and production build passing; this documentation pass does not rerun them.

This lot neither creates an external scheduler nor activates background reception. The external monitor, alert delivery and successful distant execution still require their own evidence. Preserve `PRODUCT.md`, `DESIGN.md` and `.impeccable/design.json`. Existing Support typography and eyebrow deviations already recorded in `DESIGN.md` remain local inherited behavior; this extension neither repairs nor promotes them into new design rules.
