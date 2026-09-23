---
name: "Zentra Gestion — one working window"
description: "Implemented shared screen system for desktop, mobile, dark appearance and portal forms."
colors:
  work-canvas: "#fbfbfc"
  work-paper: "#ffffff"
  work-rail: "#eceef0"
  work-soft: "#f0f1f3"
  work-line: "#dedfe3"
  work-ink: "#202125"
  work-muted: "#62656d"
  work-accent: "#286047"
  work-on-accent: "#ffffff"
  work-selection: "#dde8e2"
  work-canvas-dark: "#202125"
  work-paper-dark: "#28292e"
  work-rail-dark: "#191a1e"
  work-soft-dark: "#303238"
  work-line-dark: "#41434a"
  work-ink-dark: "#f3f3f5"
  work-muted-dark: "#b6b9c1"
  work-accent-dark: "#a3d4b8"
  work-on-accent-dark: "#173323"
  work-selection-dark: "#354b40"
  zen-attention: "#805112"
  zen-attention-dark: "#e3b96e"
typography:
  headline:
    fontSize: "clamp(30px, 2.8vw, 40px)"
    fontWeight: 650
    lineHeight: 1.16
    letterSpacing: "-.035em"
  headline-mobile:
    fontSize: "clamp(27px, 8vw, 34px)"
    fontWeight: 650
    lineHeight: 1.16
    letterSpacing: "-.035em"
  dialog-title:
    fontSize: "23px"
    fontWeight: 600
    letterSpacing: "-.025em"
  preference-title:
    fontSize: "22px"
    letterSpacing: "-.025em"
  briefing-title:
    fontSize: "21px"
    letterSpacing: "-.025em"
  section:
    fontSize: "19px"
    fontWeight: 600
    letterSpacing: "-.02em"
  subsection:
    fontSize: "18px"
    fontWeight: 600
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
  content:
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.4
  navigation:
    fontSize: "13px"
    fontWeight: 450
    lineHeight: 1.4
  navigation-mobile:
    fontSize: "15px"
    fontWeight: 450
    lineHeight: 1.4
  metadata:
    fontSize: "12px"
  compact-label:
    fontSize: "11px"
    fontWeight: 600
  keyboard-hint:
    fontSize: "10px"
  metric:
    fontSize: "clamp(22px, 2vw, 28px)"
    fontWeight: 550
    lineHeight: 1.35
    letterSpacing: "-.025em"
  metric-multiple:
    fontSize: "clamp(20px, 1.8vw, 26px)"
    fontWeight: 550
    lineHeight: 1.35
    letterSpacing: "-.025em"
  balance-mobile:
    fontSize: "clamp(28px, 9vw, 36px)"
    fontWeight: 550
    letterSpacing: "-.03em"
rounded:
  flat: "0px"
  step: "6px"
  control: "8px"
  workflow: "9px"
  mobile-action: "10px"
  panel: "12px"
  dock-item: "14px"
  dialog: "16px"
  window: "18px"
  dock: "20px"
  circle: "50%"
spacing:
  inset: "4px"
  tight: "6px"
  compact: "8px"
  control: "10px"
  small: "12px"
  icon-gap: "14px"
  medium: "16px"
  row: "18px"
  group: "20px"
  metric: "22px"
  panel: "24px"
  compact-window: "26px"
  section: "28px"
  title-top: "32px"
  columns: "36px"
  page-bottom: "48px"
  window: "clamp(24px, 3vw, 48px)"
components:
  button-primary:
    backgroundColor: "{colors.work-accent}"
    textColor: "{colors.work-on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px 17px"
  button-primary-dark:
    backgroundColor: "{colors.work-accent-dark}"
    textColor: "{colors.work-on-accent-dark}"
    rounded: "{rounded.control}"
    padding: "11px 17px"
  button-secondary:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.control}"
    padding: "11px 17px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.work-accent}"
    rounded: "{rounded.control}"
    padding: "11px 17px"
  field:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  sidebar-item:
    backgroundColor: "transparent"
    textColor: "{colors.work-muted}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  sidebar-item-selected:
    backgroundColor: "{colors.work-selection}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  destination-selected:
    backgroundColor: "{colors.work-soft}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
  filter-selected:
    backgroundColor: "{colors.work-soft}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  content-panel:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
  content-panel-mobile:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.panel}"
    padding: "20px 16px"
  dialog:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.dialog}"
  document-step-selected:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.step}"
  mobile-navigation:
    backgroundColor: "{colors.work-paper}"
    rounded: "{rounded.dock}"
    padding: "5px"
  mobile-navigation-selected:
    backgroundColor: "{colors.work-selection}"
    textColor: "{colors.work-accent}"
    rounded: "{rounded.dock-item}"
---

# Design System: Zentra Gestion

## Overview

**Creative North Star: "One Working Window"**

A restrained Apple-inspired working window: pearl-gray navigation, a continuous near-white canvas, graphite text and fine separators. Green identifies action and meaningful selection; the established Zentra wordmark remains the identity. Dark appearance preserves the same structure with distinct graphite surfaces.

This records the implemented shared screen layer across the application and its portal forms. It replaces the earlier Automation-only visual specification. The [workspace surface contract](.impeccable/surfaces/workspace.md) owns dashboard composition and module-specific arrangements; [PRODUCT.md](PRODUCT.md) owns product behavior. Printed sales documents retain their own layout, identity and colors.

**Key Characteristics:**
- One continuous working canvas with a separate navigation rail.
- System typography, aligned numbers and readable records.
- Flat grouped content, small control corners and depth reserved for dialogs.
- Compact desktop controls and safe-area-aware touch layouts.
- Matching light and dark roles, visible focus and optional motion.

## Colors

Pearl, paper and graphite form the neutral working environment. The frontmatter records the exact implemented values, including paired dark roles.

### Primary
- **Zentra green** (`work-accent`) colors primary actions, selected navigation icons, focus outlines and input carets. `work-on-accent` supplies the readable foreground; its dark counterpart is dark green on the pale accent.
- **Attention amber** (`zen-attention`) remains the existing Automation review/failed state color. It is a semantic role, not a decorative secondary accent.

### Neutral
- **Working canvas** is the continuous page surface; **paper** groups records and forms.
- **Pearl rail** separates navigation; **soft layer** marks inset search, tabs and hover feedback.
- **Fine line** divides records and outlines grouped panels or fields.
- **Ink and supporting ink** provide content hierarchy.
- **Selection** identifies active sidebar/mobile destinations and selected text.

The application uses unsuffixed custom properties, replaced under the dark theme selector. The `-dark` keys document their pairs. Older surface variables and Automation neutral roles alias the work roles inside the application; portal forms receive scoped paper/ink/line aliases. Sidecar tonal ramps are palette previews, not extra source tokens.

**The Functional Color Rule.** Use green for action and meaningful selection, and preserve written status alongside every semantic color.

## Typography

**Interface Font:** -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif. The root stack additionally includes system-ui before sans-serif, so portal content retains platform text. All ordinary interface roles inherit this family; the keyboard hint retains its existing keyboard-element family.

Titles are larger and tightly tracked; records and controls stay compact. The frontmatter captures implemented roles rather than imposing a new mathematical scale.

### Hierarchy
- **Headline / headline-mobile:** fluid page titles with the same weight and line height.
- **Dialog / preference / briefing titles:** existing form, settings and Automation headings.
- **Section / subsection:** grouped content and dashboard headings.
- **Body:** inherited interface and field text. **Content:** explanatory text and Automation detail. Paragraph line height remains contextual; section explanations retain 1.6.
- **Control:** shared actions and labels. **Navigation:** compact desktop destinations, enlarged on mobile. Selected sidebar text uses weight 600 rather than inactive 450.
- **Metadata:** dates, table headings and summaries. **Compact label:** sidebar groups and active bottom-navigation labels; inactive dock labels retain their inherited weight.
- **Keyboard hint:** supplementary desktop shortcut hint, never body text.
- **Metric / metric-multiple / balance-mobile:** fluid numeric roles for totals, multi-value totals and phone balance. The more-specific metric rule supplies the current 1.35 line height for both desktop metric roles.

**The Familiar Type Rule.** Use the platform text family for the interface; financial values and time use tabular numerals.

## Layout

Desktop uses a 220px navigation rail and 56px minimum toolbar. The working window begins with an 8px top and right margin; its content gutter uses the fluid `window` spacing token. Page headings have 32px top and 26px lower insets; content has 48px bottom padding. The native-desktop variant removes the outer working-window margin and corners so native chrome owns the edges.

At 861–1150px, the rail narrows to 202px and the gutter becomes 26px. At 860px and below, the main canvas spans the viewport, the existing drawer is min(320px, 88vw) wide, and content uses 20px horizontal insets enlarged by safe areas. The document root retains its 320px minimum width.

Phone content reserves 124px plus the bottom safe area below records. The dock has at least 10px bottom and 14px side offsets. Toolbar, drawer and form insets preserve safe areas. Panels reduce their padding, and the existing mobile-card behavior presents readable record lists instead of squeezed desktop tables.

Minimum heights are contextual: desktop sidebar 38px, shared actions 42px, fields 44px; on phone, shared actions 44px, sidebar and prominent page actions 48px, dock destinations 54px. Sidebar search grows from 36px to 44px. These are minimums, allowing translated labels to wrap.

Dashboard columns, the Automation journal and its 250px companion, and settings pane arrangements remain surface decisions. The Automation companion stacks by 1150px. On phone its destinations form three equal wrapping columns and search text uses 16px. Related records share containers and separators; settings navigation becomes a touch list.

## Elevation & Depth

Resting panels, toolbar, rail and mobile dock have no shared card shadow. Opaque tone changes and one-pixel separators establish hierarchy. Dialogs use ambient depth; their inherited backdrop remains distinct from the opaque dialog surface.

### Shadow Vocabulary
- **Dialog ambient:** `0 8px 28px rgb(20 24 30 / 8%)` in light appearance; `0 8px 28px rgb(0 0 0 / 20%)` in dark appearance.
- **Switch thumb:** inherited Automation thumb shadow `0 1px 3px #00000026` distinguishes the movable thumb.

**The Tonal Depth Rule.** Separate resting content through surface tone and fine lines. Reserve the shared ambient shadow for dialogs.

Page content settles from an 8px vertical offset over 240ms with cubic-bezier(.16,1,.3,1). Shared application buttons and sidebar selection use 140ms ease-out color/background feedback. These new treatments run only without a reduced-motion request. Existing shell, drawer, form and Automation transitions retain their own rules; the shell disables descendant animation and transition for reduced motion, and the final layer explicitly disables page arrival. Do not infer one duration for all legacy transitions.

## Shapes

Controls use the control radius; grouped panels use the panel radius. Nested panels and shared rows remain square. Desktop window top corners use the window radius; the mobile main canvas is square. Prominent phone actions use the mobile-action radius.

Dialogs use the dialog radius, with only upper corners rounded on phone. Document steps use the smaller step radius. Dock and destination corners use their distinct recorded roles. Inherited workflow-specific controls may retain the workflow radius; switches retain pill/circular geometry. These scoped exceptions do not justify giving every new region a different radius.

## Components

### Buttons
Primary uses accent/on-accent; secondary uses paper/ink and a fine border; ghost uses green on transparent fill. Shared actions have control typography, corners and no shadow. Disabled opacity is 0.55. Primary pointer hover uses brightness(.94) without translation. Keyboard focus is a two-pixel accent outline with a three-pixel offset.

Application buttons retain the existing clarity padding in the frontmatter. Normal portal buttons retain their base padding of 0 17px; the final layer aligns their type, color, radius and minimum size. Preserve scoped sizes instead of assigning one fixed height.

### Chips
Automation filters are text buttons with a 44px minimum height. Pressed state uses soft fill and ordinary ink; idle state uses muted text. Preserve `aria-pressed`. Other existing state chips keep their semantic meaning.

### Cards / Containers
Panel, table, settings, project, employee and stat containers use paper, fine borders and panel corners. Ordinary panels use panel spacing; phone panels use the reduced token. Nested panels lose side borders, corners and shadow. Dashboard sections and the Automation journal use continuous square-edged composition where the final layer removes the outer card.

### Inputs / Fields
Fields use opaque paper, ink, fine borders and control corners with a 44px minimum. Hints and fully opaque placeholders use muted ink; carets and keyboard focus use green. These rules explicitly include body-mounted modal portals. Standard field padding remains inherited from the base input style. Journal search uses a soft inset surface and its existing group focus. Validation, disabled and read-only behavior remain with existing field components.

### Navigation
Desktop rail rows use 18px SVG line icons. Selection combines a tonal fill, stronger text and accent icon. The phone drawer increases target and text sizes. Sales, team and accounting tabs share a transparent baseline, fine lower separator and soft selected fill. Automation destinations follow the same quiet selection. The phone dock is opaque, bordered and shadow-free; its old moving selection layer is hidden.

### Portal forms and document steps
Dialog headers and bodies are opaque in both themes. Desktop header padding is 22px 28px; body padding is 24px 28px. Phone headers use 18px 20px and bodies use 20px enlarged by safe areas. The document editor keeps outer body padding at zero so its internal assistant owns spacing and scrolling.

The soft stepper has paper-filled current steps, no segment shadow and wrapping labels. Phone steps form two columns; assistant step buttons have a compact 44px minimum. Footer actions remain separate from content. Line-item guidance and catalog details open on demand. While a modal is mounted, the document root locks outer scrolling; the document form remains the internal scroller, and closing the modal restores the outer state.

### Records and settings
Tables use muted 12px headers on soft fill and 18px vertical cell padding on desktop; phone card rows own their padding. Settings use preference panes, separators and progressive detail. Automation keeps its complete activity destination while dashboard attention detail opens within its briefing. Presentation does not change business state, approvals or entitlements.

## Do's and Don'ts

### Do:
- **Do** switch all shared color roles together in light and dark appearance.
- **Do** use platform text and tabular numerals for values, time and counts.
- **Do** keep focus outlines, text labels and real state evidence visible.
- **Do** let translated titles and step labels wrap on narrow screens.
- **Do** retain safe-area insets, touch targets and reduced-motion behavior.
- **Do** apply the same field and action treatment inside portal forms.
- **Do** preserve printed document colors, identity and layout.

### Don't:
- **Don't** add decorative gradients, glass panels or fabricated activity indicators to the shared working canvas.
- **Don't** replace status text with color alone.
- **Don't** turn each record or paragraph into a floating card.
- **Don't** use compact desktop navigation dimensions for touch navigation.
- **Don't** apply screen color aliases globally to printed document templates.

Source of truth: `src/workspace-atelier.css`, imported last by `src/main.tsx`, is the final shared screen presentation. `src/workspace-shell.css`, `src/automation-design.css`, base/responsive styles and components provide the noted inherited details. The final stylesheet is wrapped in `@media screen`; printed templates keep their own colors and identity. The sidecar extends these tokens with component specimens, depth, motion, responsive metadata and palette previews. This specification records implementation, not production deployment or native distribution evidence.
