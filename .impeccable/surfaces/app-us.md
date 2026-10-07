---
version: 1
slug: "app-us"
primary_target: "app/us"
related_targets: ["components/us","app/us/us.css"]
---

# Zentra /us — surface brief

Scope: a public US market experiment; Persuade mode. Audience: service SMBs, primarily 5–30 people. Primary action: apply for early access. Inherit the existing green Zentra brand, wordmark, Geist/system type and restrained product surfaces. The supplied detailed brief fixes the composition and workflow examples; no open direction selection is needed.

October 7 offer update, requested by the owner: present the US version as coming soon, give Management a full benefits section in US terminology, and offer one free month from US access activation. No credit card, commitment, automatic renewal or charge; continuing requires an explicit paid-plan choice. The existing Swiss product and identity stay authoritative. Existing product capabilities are the foundation, with US availability confirmed before pilot activation.

## Direction contract

THESIS: incoming business information becomes reviewable work. Product understanding and a measurable application are the page's purpose.

OWN-WORLD: forest green #173d2c, pale neutral #f8faf7, sage secondary type; restrained 12px product frames, open layouts and generous section spacing. Existing brand and UI primitives remain authoritative.

STORY: understand the busywork problem, explore a deliberately labeled pilot workflow, see how the three modules connect, then submit a real application.

FIRST VIEWPORT: large left-aligned headline and clear pilot CTA; beside it, a readable email-to-record demonstration. On mobile the copy precedes the same full-width demonstration. No stock AI illustration.

FORM: code-led extension of the incumbent visual system; supplied brief pins the page structure. Seed key: not applicable to this precisely specified existing-brand extension. Signature interaction: slow, pausable email classification and field extraction, with explicit human review. Reduced motion shows the completed example immediately.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

The existing repository has no DESIGN.md. This extension records its route-specific decisions here and does not invent or replace a global design system. The only added raster is a browser-rendered social preview from native product typography and the existing brand asset.

Initial extension check (2026-10-07, before the owner-requested offer update): the finished `/us` surface retains Zentra's wordmark, green identity and Geist/system typography, and reuses `BrandMark`, `BrandWordmark`, `Button`, `Dialog`, `Input` and `Textarea`. Route-local sizing, restrained 6–12px corners and the pale canvas follow this brief; they do not redefine shared tokens. Checked the incumbent capture, all four viewport captures (1440, 820, 390 and 320px), hero/form crops, browser results and final build log. The browser record reports no horizontal overflow and completed static examples under reduced motion. The finish reviewer returned `ship` after scoring the four listed corrections resolved. Baseline hashes confirm `PRODUCT.md`, both global stylesheets and the five shared component files unchanged. The absent `DESIGN.md`/`.impeccable/design.json` and existing layered CSS remain pre-existing documentation/system drift outside this extension. The social PNG embeds its browser-rendered origin; no new global documentation, UI or source edits were made by this documentation pass.

Final offer/Management recheck (2026-10-07): the six Management benefits and Customer → Estimate → Project → Invoice illustration extend the same open layout, green palette, typography and shared primitives. Checked all nine current captures, including desktop/mobile Management views, against the incumbent identity; the four viewport browser records still show zero horizontal overflow and no runtime errors. `build-offer-final.log` confirms the final production build. The implementation validation record reports 62 passing tests and the offer-version RLS check passing. The new full finish review returned `ship` with no material fixes. Coming-soon availability and the owner's one-free-calendar-month offer remain explicit: activation starts the month, with no card, commitment, automatic renewal or charge, and an optional paid plan afterward. The server fixes the recorded offer version; candidature does not grant a licence. Rechecked all eight preserved-file hashes and the updated social PNG origin. Swiss licensing, global files and pre-existing design-documentation drift remain unchanged; this recheck edits only this documentation.
