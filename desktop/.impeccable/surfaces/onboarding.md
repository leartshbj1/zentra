# First launch — guided company setup

Mode: Operate. Shared React UI on Windows, macOS, iOS and Android. User chose the complete setup at first launch, then “Un guide à vos côtés”, code-led. Keep real native commands, permissions, account resolution and validation.

## Direction contract
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
