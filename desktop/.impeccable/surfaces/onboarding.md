# First launch — guided company setup

Mode: Operate. Shared React UI on Windows, macOS, iOS and Android. User chose the complete setup at first launch, then “Un guide à vos côtés”, code-led. Keep real native commands, permissions, account resolution and validation.

## Previous direction contract — superseded on 2026-09-25
THESIS: One calm guide beside a short task, replacing the long mixed welcome screen and overloaded identity form.

OWN-WORLD: Inherit Zentra’s Apple-like workspace: opaque paper, system type, green action, quiet neutral chapter index. Both existing themes remain authoritative.

STORY: Arrive, connect or recover an existing company, configure identity, activity, documents, work, payroll and protection, review and create. Every relevant setting is available now. An optional module stays an explicit choice.

FIRST VIEWPORT: A narrow permanent guide at left; a large welcome mark settles above one sentence in the central paper. Language and appearance sit quietly at top; one start action anchors the content. Subsequent short pages share a stable title, fields and footer. Mobile uses a compact expandable chapter index, safe area padding and full-width actions. The welcome reveal and the advancing chapter check form one restrained motion vocabulary.

FORM: Grounded list: 1 indexed setup assistant; 2 live company identity preview; 3 setup checklist; 4 protected-focus dialog; 5 horizontal step rail; 6 unfolding dossier; 7 one-screen journey. Seed 43aca628 dealt 7, 6, 1; user selected 1, indexed guide. Existing visual world is unchanged.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Evidence and constraints
Use current 1.86.1 components and native validation. Preserve old drafts and all advanced settings, connection/join/restore paths, logo staging, payroll evidence and account-scoped access. Only complete confirmed data is persisted. Errors route to their field. Opening an existing company must not create a new one. Synthetic browser fixtures do not prove native installation.

## Implementation record — 2026-09-24

This is an extension of the established world, not a replacement. The FINISH requirement above is satisfied by checking the existing [DESIGN.md](../../DESIGN.md) and [.impeccable/design.json](../design.json), preserving them, and recording the surface decisions here. The global tokens remain authoritative for the workspace; these onboarding compositions and exceptions must not become global rules.

The implementation is [OnboardingJourney.tsx](../../src/OnboardingJourney.tsx), [OnboardingSteps.tsx](../../src/OnboardingSteps.tsx) and [onboarding-journey.css](../../src/onboarding-journey.css), with page/chapter mapping in [onboardingFlow.ts](../../src/onboardingFlow.ts). It exposes seven chapters and 15 pages, or 13 when payroll is disabled. The complete setup covers the existing onboarding settings; the chart of accounts and future collaborator-specific settings remain in their respective modules, as recorded in the [delivery note](../../../docs/ONBOARDING-GUIDE-20260924.md).

### Composition and inherited design

- The desktop guide is 264px, 288px from 1440px, and 218px at 1000px and below. Content is a single paper area capped at 670px. At 700px and below, the guide becomes an expandable index; forms use one column. These are surface breakpoints, not replacements for the workspace's 860px breakpoint.
- Accent/on-accent, main ink, muted ink, paper and selection values match the established light/dark roles. Opaque surfaces, system typography, separators, tabular progress counts and existing line icons carry the incumbent character. The chapter selection uses the soft selection role with an accent step marker.
- Inputs retain 16px text, 46px minimum height and the incumbent 9px control radius. First-run actions use the established 10px mobile-action radius; panels and notices use existing 12px/14px shapes. Logo actions retain 42px on desktop and now explicitly use 46px on mobile. The mobile index and its chapter controls are at least 48px.
- Mobile top/right/bottom/left padding prioritizes the native `--safe-*` properties with `env(safe-area-inset-*, 0px)` fallback. The small 350px breakpoint preserves horizontal safe areas. Focus remains visible; page changes focus the heading, and validation opens enclosing details before focusing the relevant field.
- `BrandMark` and `BrandWordmark` are reused from the existing [brand component](../../src/BrandMark.tsx); the latter uses the existing `src/assets/zentra-wordmark.png`. No new raster was authored for this surface. User-supplied company logos remain user content. The absent optional concept-image path is not a shipping asset obligation.

### Accepted surface exceptions

The [finish review](../../.qa/onboarding-redesign/finish-review.md) accepts the progress-track and type advisories as purposeful local choices:

- A 2px corner radius belongs only to the 3px progress track. It does not add a general 2px control token.
- The welcome heading uses `clamp(38px, 4.2vw, 56px)`, then 40px at 700px and below and 35px at 350px and below. This welcome scale does not replace workspace headline tokens.
- Intermediate text sizes are local: 15px for supporting welcome/mobile copy, 17px for review/assistant section titles and 24px for the account linking code.

Other observed local implementations are recorded, not promoted into the global system: the onboarding line/soft colors differ slightly from the work-line/work-soft tokens; the font stack omits Segoe UI Variable, headings use weight 650, and focus offset is 4px. Their exact values and the global documentation's import-order drift are listed in the [documentation check](../../.qa/onboarding-redesign/documentation-check.md). This handoff does not repair them or imply an exact token-for-token match.

The welcome mark arrives over 1100ms, its title over 900ms, and page changes use a 260ms directional transition. Reduced-motion preference disables the surface's animations and transitions. Existing captures establish readable resting states; CSS establishes the animation rules, not a recorded motion test.

### Finish evidence and limits

The independent [review](../../.qa/onboarding-redesign/finish-review.md) requested two CSS corrections. Its [final verdict](../../.qa/onboarding-redesign/finish-verdict.md) is `ship`: native safe-area precedence and mobile logo targets are resolved, with no regression visible in the 15 reopened captures. The verdict covers those corrections and does not expand to installed-device validation.

- [journey-results.json](../../.qa/onboarding-redesign/journey-results.json) records 360 layout cases across 15 pages, four languages, three widths and two themes, plus passing mocked creation/rejection/retry, draft preservation, restore cancellation, assistant, existing-company and WebKit paths.
- [ios-platform.json](../../.qa/onboarding-redesign/ios-platform.json) records passing native-inset-variable checks at 320px/390px, logo targets above the 44px floor, WebKit touch and the iOS compile-time backup path; it explicitly records `nativeDeviceTest: false`.
- [frontend-tests.log](../../.qa/onboarding-redesign/frontend-tests.log) records 1,651 passing tests in 203 files. [build-final.log](../../.qa/onboarding-redesign/build-final.log) records successful TypeScript/Vite compilation with the existing chunk-size warning.

The documenter reused these existing artifacts and did not run UI QA, a detector, a build or tests. Browser fixtures use synthetic company data and mocked native APIs; they do not prove an installed application, real cloud connection, production success or distribution. No native package or deployment was produced for this lot.

## Current direction contract — 2026-09-25

User rejected the prior interface as old administrative software, specifically the welcome and connection button. Their pinned sequence is a quotation, a large magical animation, then the Zentra logo. Full configuration and the previously selected guide remain required. This local replacement supersedes the old first viewport, not the workspace system. Code-led remains the recorded choice. No new concept tournament is needed for this precisely specified sequence.

THESIS: An arrival worth watching once; then a personal, approachable setup that gets out of the way.

OWN-WORLD: Existing Zentra wordmark and Apple-like system typography. The introduction owns a full-bleed forest-green stage; the configuration returns to the selected light/dark workspace. No global redesign, invented operational claims or new font dependency.

STORY: A Steve Jobs quotation gives way to luminous orbital filaments. Particles gather into the actual Zentra wordmark, which resolves to its clean asset. Start opens a centred account page. Connecting, joining, restoring and configuring remain distinct, real actions. The quiet guide returns with the forms.

FIRST VIEWPORT: Full-screen quotation, generous type and a finite canvas light sequence, followed by the real wordmark at centre, a short line and one start button. No permanent chapter index before the company form. Account has a full-width primary connection button; local setup is secondary. Forms use softer fields, spacious type and a calm index instead of selected navigation tiles.

FORM: User-pinned chronological sequence. Signature interaction: bounded orbital linework and sampled logo particles converge into the real brand asset. 7.8 seconds of animation; always skippable, replay on request, stops at rest and while hidden. Reduced motion goes directly to the readable resting state. Normal form transitions remain 260ms. Mobile preserves touch targets and native safe-inset precedence; four locales remain supported.

FINISH: Fresh full review required because the user rejected the previous ship verdict. Source integration and browser fixture evidence must not be represented as native installation or distribution. Document local exceptions; preserve global DESIGN.md and design.json.

Quote origin: Steve Jobs, Stanford commencement address, 12 June 2005, https://news.stanford.edu/stories/2005/06/youve-got-find-love-jobs-says. English excerpt: “The only way to do great work is to love what you do.” French, German and Italian are our translations. Existing wordmark source: src/assets/zentra-wordmark.png. No new raster assets.

## Current implementation record — 2026-09-25

**Authority:** this section and the current direction contract immediately above describe the implemented arrival. The earlier direction, the “Implementation record — 2026-09-24”, its accepted exceptions, motion description and `ship` verdict are historical records of the interface the user rejected. They remain for provenance, not as approval or instructions for the current arrival. The full setup behavior retained from that implementation is distinguished below from the replaced composition.

This is a local replacement within the established Zentra identity. [DESIGN.md](../../DESIGN.md) and [design.json](../design.json) were read and preserved. Their workspace tokens remain authoritative outside this surface; the forest stage, display sizes, form colors and pill controls below are not additions to the global system.

### Implemented sequence and composition

- [OnboardingIntro.tsx](../../src/OnboardingIntro.tsx) owns the first viewport: a full-height quotation, luminous orbital linework, particles sampled from the actual wordmark, then the clean logo and “Commencer”. Language and appearance stay available above the sequence. There is no chapter guide on this arrival.
- [OnboardingJourney.tsx](../../src/OnboardingJourney.tsx) gives account entry its own centred sheet (490px maximum). “Se connecter” is the full-width primary action. Invitation, backup recovery and “Créer une entreprise” remain separate paths; local creation uses a softer secondary treatment. The existing secure-browser authentication remains in [CloudAccountPanel.tsx](../../src/CloudAccountPanel.tsx).
- Company forms restore the seven-chapter guide. The source retains 15 pages, or 13 when payroll is disabled, including identity, address, activity, TVA, banking, documents, work, payroll, insurance, contributions, backup, optional assistants and review. Existing-company opening, join/restore callbacks, complete validation and draft migration remain present; the arrival does not establish new account or business rules.
- The effective form composition is a 320px guide and a content sheet capped at 640px. The guide is 360px from 1500px; between 701px and 1100px it is 260px. At 700px and below, the chapter index becomes expandable and the form grid becomes one column. Account and arrival remain full-width compositions at all these sizes.
- The active chapter is a quiet text row with a filled circular step marker and soft selection ring, rather than a selected navigation tile. The progress fraction and bar both use the current chapter's enabled pages; the accessible progress label names that chapter. For example, Documents is 3/3 and Sauvegardes is 1/1, both complete bars.

### Local palette, type and control decisions

The effective values come from the final scoped arrival rules in [onboarding-journey.css](../../src/onboarding-journey.css), including their later responsive and theme overrides. Earlier declarations in that file are not alternate current designs.

| Local role | Implemented value and use |
| --- | --- |
| Forest stage | Deep forest (`#071e19`) in both chosen themes; pale main ink (`#effaf4`) and quotation ink (`#f1faf5`). The introduction intentionally has one scene palette, then returns to the chosen setup theme. |
| Quiet scene text | Secondary text (`#b8ccc2`), signature/citation text (`#c7d9cf`), citation detail (`#a7c2b4`) and skip text (`#d2e6da`). The scene's preference focus/accent is pale mint (`#d6f9e6`), with a local line role (`#446256`). |
| Start action | Pale surface (`#e9f6ed`) and forest ink (`#123d2b`); white on hover. This pairing belongs only to the intro start action. |
| Light setup surfaces | Canvas/fields (`#f6f7f6`), white paper, soft fill (`#f0f2f0`), line (`#d4dad5`). Accent, main ink and muted ink retain the established light roles. |
| Dark setup surfaces | Canvas/fields (`#1c1f1e`), paper (`#242826`), soft fill (`#303733`), line (`#525c55`). Accent, on-accent, main and muted ink retain the established dark roles. |

The application system stack is retained, including Segoe UI Variable at the first-run root. Existing field-label declarations retain their narrower Segoe UI stack. No display-font dependency was added; the large system type follows the user's established Apple-like brief.

| Local type role | Effective size / weight |
| --- | --- |
| Opening quotation | `clamp(28px, 4vw, 52px)` / 450, line-height 1.23; 34px on phone and 28px at 350px or below. |
| Resting quotation | 16px / 450, then 14px on phone and 13px at the narrow/short viewport rules. |
| Form headline | `clamp(34px, 3.5vw, 48px)` / 550, line-height 1.12; 34px on phone and 30px at 350px or below. |
| Account headline | `clamp(36px, 4vw, 52px)` / 550; 38px on phone, then the later shared narrow-screen rule yields 30px at 350px or below. |
| Guide prompt / logo caption | Guide prompt 24px, or 22px on compact desktop, / 550; logo caption `clamp(17px, 1.8vw, 22px)` / 400. |
| Controls and detail | Start/connect 17px / 550; input text 16px; field labels 13px / 500; account code 24px. These are local roles, not a replacement workspace type ramp. |

Fields use a soft opaque fill, 12px corners, a 52px minimum height and `13px 16px` padding. Their transparent resting border becomes the scoped line on hover, the accent on focus and the error role for invalid values. Setup actions use 24px corners and 48px minimum height. The connection action has 30px corners and a 58px minimum; the start action has 30px corners and a 56px minimum. These pill-shaped actions are approved by the local direction only. The 2px radius remains confined to the 3px progress track. No hard offset shadow, glass panel or new decorative card system is introduced.

### Motion, focus and states

- The active animation clock runs for 7800ms: quotation until 3200ms, light phase until the logo reveal at 5700ms, then ready at 7800ms. The canvas draws 38 orbital ribbons and a bounded particle sample (up to 950 on narrow screens or 1600 otherwise), with device-pixel ratio capped at 1.75. It uses the existing image locally, with no remote animation asset, sound or animation library.
- “Passer l’introduction” is available while playing. Completion, skip and start remember the intro on this device; a return or later opening goes to the resting composition. “Revoir l’introduction” is an explicit replay action. The frame loop pauses while the document is hidden, cancels and clears at rest/unmount, and falls back to ready when a canvas context is unavailable. An unreadable image sample does not block entry.
- Reduced motion goes directly to the readable resting composition, hides the canvas and replay control, and disables the surface's animations, transitions and smooth scrolling. Changing the preference while playing also resolves to ready. Normal form changes retain the directional 260ms transition with `cubic-bezier(.16,1,.3,1)`.
- Intro focus belongs to the visible quotation at entry/replay, moves to skip when the quotation disappears, then to start when the sequence finishes or is skipped. It does not take focus back from language/appearance controls. The generic journey heading focus skips step 0; later page changes focus their heading. The canvas is decorative, and unavailable quote/identity content is removed from the accessibility tree through the phase-specific attributes.
- The focus-visible contour is 2px with a 4px offset. Mobile chapter rows remain at least 48px, the compact chapter selector 52px, preferences and help at least 44px, and logo actions 46px. Main safe-area rules prioritize native `--safe-*` values over `env()` fallbacks, including the intro's mobile quotation padding. Short landscape views reduce the logo and put the resting controls in a row; the already-presented quotation is hidden in the smallest landscape resting layout.
- Account loading, disconnected, pending, connected, expired/inactive, busy and error states remain explicit. Pending connection retains the code, secure-page reopening, copy feedback and recovery details. The code label now explicitly uses full-opacity muted ink with no filter. Draft saving/saved/failure, invalid fields, a linked validation summary and creation/retry feedback remain in the setup. Validation opens enclosing details before focusing the affected field.

### Asset and text provenance

[BrandWordmark](../../src/BrandMark.tsx) reuses [src/assets/zentra-wordmark.png](../../src/assets/zentra-wordmark.png). The canvas samples this same raster's pixels; the final mark is the original image rendered in white by CSS, not re-created text. No new raster or replacement logo was authored. User company logos remain user-supplied content.

The quotation source recorded in the contract is [Steve Jobs's Stanford commencement address, 12 June 2005](https://news.stanford.edu/stories/2005/06/youve-got-find-love-jobs-says). French, German and Italian are project translations; attribution stays visible. The light choreography is code-authored. This documentation pass does not claim external verification of source ownership or authorship beyond the supplied repository and quotation provenance.

### Current finish evidence and limits

The [fresh review](../../.qa/onboarding-arrival/finish-review.md) returned `fix` for intro focus, mixed progress scopes and pending-code label contrast. Its [final verdict](../../.qa/onboarding-arrival/finish-verdict.md) is **`ship`, limited to those three scored corrections**, all resolved. The reviewer found no regression attributable to that correction batch in the reopened captures and scoped source changes. This is not a new whole-surface or native release certification; the earlier rejected design's verdict is not reused as approval.

[journey-results.json](../../.qa/onboarding-arrival/journey-results.json) records 360 passing local layout cases across 15 pages, four languages, three widths and two themes, plus synthetic creation/rejection/retry, draft, restore cancellation, assistant, existing-company and WebKit scenarios. The final verdict confirms matching complete progress bars for Documents 3/3 and Sauvegardes 1/1. The refreshed [motion-results.json](../../.qa/onboarding-arrival/motion-results.json) passes at 1293px and 390px, plus reduced motion; the verdict records the supplied focus assertions for entry, light, natural completion, skip, replay and preservation of preference-control focus. These are local browser observations, not device performance benchmarks. [label-contrast.json](../../.qa/onboarding-arrival/label-contrast.json) measures the final pending-label pixels as `#62656d` on `#f6f7f6`, a 5.429:1 ratio. [build.log](../../.qa/onboarding-arrival/build.log) records successful TypeScript/Vite compilation and the chunk-size warning. The existing [iOS fixture report](../../.qa/onboarding-redesign/ios-platform.json) explicitly declares `nativeDeviceTest: false`; its iOS branch and safe-inset checks are browser evidence.

The supplied [detector](../../.qa/onboarding-arrival/detector.json) has 32 advisories (8 color, 20 type-size, 4 radius) and no non-advisory finding. Its local design departures are documented above, not silenced through global token changes. See the [documentation check](../../.qa/onboarding-arrival/documentation-check.md) for preservation and scope evidence.

The documenter read existing code and artifacts only: no UI edit, screenshot, detector rerun, build or test was performed. The fixtures use synthetic companies and mocked native commands. This lot does not establish a real cloud session, installed-device behavior, native packaging, distribution or production success. No native installer or publication was produced for this change; the recorded application version remains 1.86.1.
