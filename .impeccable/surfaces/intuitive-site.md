# Zentra — an intuitive product journey

Mode: Persuade. Ordinary extension of the existing Zentra Studio world.

## Product priority — user correction, 24 September 2026

The annotated homepage feedback explicitly demotes the demo. In the four-choice product finder, the filled primary action now opens the selected product presentation; the demo, activation guidance or plan comparison remains a plain secondary link. Gestion and Support name that secondary route “Voir la démo”. On the linked Gestion presentation, the hero leads to its feature section, the contextual menu highlights Download and lists the app visit as an ordinary navigation link, and the final action highlights Download with the demo secondary. The image tour remains available. This changes only discovery hierarchy and matching CTA labels, preserving prices, routes, account and purchase behavior, Studio styling, accessibility and mobile wrapping.

Documentation complete: this user correction locally overrides the earlier demo-first CTA hierarchy in the finder and Gestion journey. It reuses Studio's existing filled primary actions and plain secondary links; it introduces no new visual tokens or system-wide rule. `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, CSS and the app tour remain unchanged by this correction.

Evidence checked: the final three-file diff, this contract and `.impeccable/review/product-priority/finish-review.md`. The fresh review contains all five required sections, disposition `ship`, eight valid supplied captures and no material fixes. It records 20 passing browser checks with no errors; changed-file lint and an empty detector result are supplied build evidence. The Gestion final action was reviewed from source and the behavior report, not a dedicated capture. This documentation pass ran no browser or new audit; the outcome covers this CTA correction only and is not publication evidence.

## Direction contract

THESIS: Make the connection between the three products tangible in one short, controllable example, then make choosing a product effortless. This extends the user-approved Studio world and Apple simplicity.

OWN-WORLD: Geist, white and pearl surfaces, forest-green actions and charcoal text. A spacious centered proposition leads into a single working document surface. No new imagery or decorative glass.

STORY: See a received message become useful information, understand each product's role, choose the appropriate tool or pack, and reach a real demo or plan page.

FIRST VIEWPORT: A compact global header, centered proposition and two clear actions. The beginning of the interactive workflow is visible beneath. The proposition uses two lines on desktop and wraps naturally on narrow phones. On a phone the header occupies one row, the three scenario controls share a row with wrapping labels, and the example becomes a vertical document and explanation.

FORM: Ordinary extension of Studio, user-pinned Apple-like clarity. Code-led preview already selected; no new direction roll or image comp.

MOTION: One signature interaction: the same example progresses from Support receipt through Automation recognition to its destination. A short ease-out state transition, explicit play/pause/replay, immediate manual controls, and reduced-motion support. Navigation unfolds once with keyboard Escape and click-away closure.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries

Preserve prices, routes and destinations, copy meaning, authentication, subscriptions, selected-company context, permissions, user data, business rules, payments and integrations. Keep Projet/Projets terminology. Examples are fictitious and clearly labeled; no invented customer, testimonial or measured gain. No automatic reply sending or bank payment, and no guaranteed processing of uncertain data. E-mail workflows retain the same-company Support/Gestion and compatible-connection dependencies, enabled rules and confidence controls. This presentation does not enable the all-apps-closed scheduler. Validate desktop 1440, tablet 768, phone 390 and narrow 320 and keyboard continuity; local responsive checks are not physical-device validation.

## Implemented surface — 24 September 2026

- `components/home-experience.tsx` contains the centered introduction, three illustrative scenarios and the product finder. `components/products-home.tsx` retains the product range, Complet banner, Automation explanation, FAQ and footer around them.
- The invoice, appointment and customer-request scenarios each have receipt, recognition and destination states. Play advances every 1900ms after user activation and stops at the result. Pause, replay, step buttons and “Voir la suite” remain available; scenario changes reset to receipt and stop playback. Hiding the browser document also stops playback. Conditions are available below the example.
- The explanation subtree remains mounted during manual advancement. Focus stays on “Voir la suite” for the first advance, then moves to the Automation result link for the final advance. Document content alone remounts for its visual transition.
- The finder has four needs: Gestion, Support, Automation and Complet. It exposes each product's existing price/dependency note and real demo, activation or plan destination. Its selected result is announced politely.
- `components/site-header.tsx` adds a universal product menu and direct links. Desktop product links and contextual product navigation remain. At 760px and below, the global row contains the brand, account and menu button; product choices live in the menu. Escape restores focus to the opening control; outside pointer, focus leaving the header, route changes and menu-link selection close it. Universal and contextual menus are mutually exclusive.
- `app/intuitive-site.css`, imported after `studio.css` by `app/layout.tsx`, owns this extension. It reuses Studio colors, actions and easing, with white documents on pearl surfaces and restrained shadows. At 760px and below, document/explanation and finder columns stack; 1000px and 359px rules refine spacing. New document/finder arrivals use 400ms and the menu 320ms. Reduced motion disables those arrivals and the added progress/arrow transitions; user-controlled state progression remains available.
- No new raster asset ships. Visuals use HTML/CSS and existing SVG icons/wordmark; review PNGs are evidence files.

## System comparison and evidence

`DESIGN.md` and `.impeccable/design.json` are preserved. Their incumbent asymmetric homepage, mobile navigation row and 2100ms story timing describe the earlier Studio surface; the centered layout, disclosure menu and 1900ms timing above are local extension behavior. They are not silently promoted into system-wide rules.

The existing detector output in `.impeccable/review/magic/detector.json` contains 29 advisory findings (27 type-ramp and 2 color variations), with no non-advisory finding. These differences remain visible and were not hidden by rewriting tokens. Earlier local drift already recorded in `DESIGN.md` (download amber accents, Support overlines and system-font headings) remains outside this documentation pass.

The final `checks-edge.json` and `checks-webkit.json` in that evidence directory each record 78 passed checks and an empty failures array, including both manual-advance focus assertions. Captures cover 1440, 768, 390 and 320 widths, menu, result, finder and product states. The finish reviewer returned `ship` for the listed keyboard-continuity correction, scored resolved; that verdict is a correction verdict, not a fresh whole-site certification or publication proof.

WebKit used a local HTTP test harness that removed the response CSP header to avoid upgrading preview assets to an unavailable local HTTPS server. Production CSP was unchanged. This is WebKit automation, not Safari on a physical iPhone. Details and verification limits are recorded in `docs/INTUITIVE-SITE-20260924.md`.
