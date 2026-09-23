---
name: "Zentra Gestion — quiet workspace"
description: "Implemented visual system for Automation and shared application navigation."
colors:
  zen-canvas: "#f6f6f8"
  zen-panel: "#ffffff"
  zen-soft: "#ededf0"
  zen-rail: "#f0f0f3"
  zen-ink: "#222226"
  zen-muted: "#67676f"
  zen-line: "#e3e3e8"
  zen-accent: "#286047"
  zen-attention: "#805112"
  zen-selection: "#ffffff"
  zen-canvas-dark: "#19191c"
  zen-panel-dark: "#222225"
  zen-soft-dark: "#303035"
  zen-rail-dark: "#202023"
  zen-ink-dark: "#f2f2f5"
  zen-muted-dark: "#aaaab4"
  zen-line-dark: "#38383e"
  zen-accent-dark: "#a2ceb6"
  zen-attention-dark: "#e3b96e"
  zen-selection-dark: "#35353a"
  action-ink-dark: "#182d23"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "28px"
    fontWeight: 650
    letterSpacing: "-.03em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.025em"
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-.025em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  row-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 550
  metadata:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  filter: "8px"
  control: "9px"
  group: "12px"
  panel: "16px"
  switch: "20px"
spacing:
  inset: "4px"
  compact: "8px"
  small: "12px"
  medium: "16px"
  row: "18px"
  group: "20px"
  panel: "24px"
  section: "28px"
components:
  button-primary:
    backgroundColor: "{colors.zen-accent}"
    textColor: "{colors.zen-panel}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1rem"
  button-primary-dark:
    backgroundColor: "{colors.zen-accent-dark}"
    textColor: "{colors.action-ink-dark}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1rem"
  button-quiet:
    backgroundColor: "{colors.zen-soft}"
    textColor: "{colors.zen-ink}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1rem"
  button-destination:
    backgroundColor: "transparent"
    textColor: "{colors.zen-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  filter:
    backgroundColor: "transparent"
    textColor: "{colors.zen-muted}"
    rounded: "{rounded.filter}"
    padding: "8px 12px"
  filter-selected:
    backgroundColor: "{colors.zen-soft}"
    textColor: "{colors.zen-ink}"
    rounded: "{rounded.filter}"
    padding: "8px 12px"
  search:
    backgroundColor: "{colors.zen-canvas}"
    textColor: "{colors.zen-ink}"
    rounded: "{rounded.filter}"
    padding: "0 10px"
  navigation-item:
    backgroundColor: "transparent"
    textColor: "{colors.zen-muted}"
    rounded: "{rounded.control}"
    padding: "10px 22px"
  navigation-item-selected:
    backgroundColor: "{colors.zen-panel}"
    textColor: "{colors.zen-ink}"
    rounded: "{rounded.control}"
    padding: "10px 22px"
  content-panel:
    backgroundColor: "{colors.zen-panel}"
    textColor: "{colors.zen-ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
  settings-group:
    backgroundColor: "{colors.zen-panel}"
    textColor: "{colors.zen-ink}"
    rounded: "{rounded.group}"
    padding: "20px"
  switch:
    backgroundColor: "{colors.zen-soft}"
    rounded: "{rounded.switch}"
    width: "42px"
    height: "26px"
---

# Design System: Zentra Gestion

## Overview

**Creative North Star: "The Quiet Workspace"**

A quiet, contemporary application workspace: cool neutral surfaces, familiar system text, fine separators and restrained green. The existing Zentra identity stays visible while controls and factual content carry the visual emphasis.

This records the implemented Automation interface and the shared menu and page-title treatments. It is not a claim that every legacy screen or printed document already uses this system. The activity-first composition and destination order belong to the [Automation surface contract](.impeccable/surfaces/automation.md); durable product constraints remain in [PRODUCT.md](PRODUCT.md).

**Key Characteristics:**
- Cool neutral layers with green reserved for meaningful state and action.
- Compact text hierarchy, familiar controls and progressive detail.
- Light and dark themes with the same semantic roles.
- Readable touch layouts and quiet, optional interaction motion.

## Colors

A cool paper-and-charcoal palette makes the green identity and amber attention states easy to locate.

### Primary
- **Zentra green** (`zen-accent`): action controls, completed-state text, selected menu icons and input carets. The dark theme uses its lighter paired role.
- **Attention amber** (`zen-attention`): review and failed states that require a person. It is a semantic state color, not a second decorative accent.

### Neutral
- **Canvas, panel and soft layer**: page background, grouped content and selected or hover fills.
- **Navigation rail and selection**: an independent quiet rail and the active menu item.
- **Ink and muted ink**: readable content and supporting labels.
- **Fine line**: row separators and restrained control boundaries.
- **Dark action ink**: the dark foreground used on the pale green workflow action button.

The frontmatter lists the exact source values. The `-dark` entries document the matching CSS roles under `html[data-app-theme='dark']`; the running application continues to use the unsuffixed custom-property names. Metadata ramps in the sidecar are generated palette previews, not additional implementation tokens.

**The Functional Color Rule.** Use green for action, selected icons and completed work; use amber for attention. Keep a written state label alongside color.

## Typography

**Interface Font:** -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif.

The platform text family is an explicit part of the approved application direction. Headings gain importance through size, weight and tighter tracking, without introducing a marketing display face.

### Hierarchy
- **Headline**: page title; its desktop token reduces to 24px at the mobile breakpoint.
- **Title**: introductory heading; reduces to 22px on mobile.
- **Section**: journal heading, with smaller work-group headings where needed.
- **Body**: ordinary detail and settings text. Settings and row titles use the recorded 1.5 line height; inherited explanatory paragraphs vary from 1.55 to 1.6 and remain bounded at 65–70ch.
- **Row title**: medium-weight text that wraps without hiding the activity name.
- **Label / metadata**: compact controls, dates, time and supporting detail. Navigation uses 14px text and a 550 weight; inactive sidebar labels use 450 and active ones 600.

Numeric content uses tabular numerals. The small count marker is 11px and is supplementary to a named destination; it is not a body-text size.

**The Familiar Type Rule.** Use the platform text family for interface headings and content. This application has no separate display-face role.

## Layout

Use grouped content with generous space between sections and compact spacing inside controls. The frontmatter records reused spacing steps; this is not a rigid mathematical scale.

Automation is bounded to 1120px, while its settings column is bounded to 760px. The surface contract owns the journal/sidebar composition. At 1100px its companion column stacks; at 760px navigation spans the available width, row status moves below its title and panels reduce their horizontal padding. At 380px the journal reduces its horizontal inset again. These breakpoints are scoped to the implemented surface.

Primary navigation and ordinary action/filter controls have a minimum height of 44px. Search text becomes 16px on mobile. Settings switches have a smaller visible track inside a larger clickable label. Long translated labels and titles must preserve readable wrapping. Keep the inherited mobile drawer and safe-area behavior.

## Elevation & Depth

The new content panels are flat at rest. Canvas, panel and soft fills, plus one-pixel separators, provide most of the hierarchy. The existing application shell retains its own overlay treatment outside this extracted content system.

### Shadow Vocabulary
- **Selected segment:** `0 2px 5px #00000009`; a very small lift inside the navigation group.
- **Switch thumb:** `0 1px 3px #00000026`; separates the movable thumb from its track.

**The Tonal Depth Rule.** Separate resting surfaces through tone and fine lines. Small shadows explain a selected segment or movable switch thumb, rather than lifting every container.

## Shapes

Controls use gently rounded corners, with a slightly tighter filter/search radius. Navigation groups and grouped settings are larger; content panels use the panel radius. Rows remain square within their shared container and meet at a fine bottom divider. The switch is a pill with a circular thumb. Use plain SVG line icons, without decorative colored tiles.

## Components

### Buttons
Quiet, recognizable controls with clear action hierarchy.
- Workflow actions use green with white text in light appearance and dark ink on pale green in dark appearance. Quiet workflow actions use the soft fill and ordinary ink.
- Destination buttons use a fine line, transparent fill and the control radius; hover introduces the panel fill.
- Workflow buttons have a 44px minimum height, medium weight and a two-pixel focus outline with a three-pixel offset. Disabled workflow actions use 0.5 opacity. Preserve each existing variant's scope rather than merging all older shared button treatments into one token.
- Background and text feedback uses 160ms ease-out when motion is permitted.

### Chips
Journal filter chips are text buttons: transparent when idle, soft-filled when selected, with `aria-pressed` carrying the state. They keep a 44px minimum height. Small counts use compact rectangular markers, never fabricated status signals.

### Cards / Containers
Content groups use panel fill, panel corners and no card shadow. Ordinary content panels use the panel spacing token; the journal has its own asymmetric inset in the surface stylesheet. Settings use the smaller group corners and group padding. Related rows share a container instead of receiving independent cards.

### Inputs / Fields
The journal search is an inset canvas-colored field, with a line search icon and no border. Its transparent input has a 44px minimum height. Focus belongs to the whole search group: two-pixel accent outline, two-pixel offset. The input caret uses the accent. The search input's mobile text grows to 16px.

### Navigation
The sidebar is a neutral rail. Inactive text and icons are muted; selection combines the selection fill, stronger text and a green line icon. Sidebar items have 44px minimum height and 19px icons.

The Automation destination group uses soft fill with a panel-colored selected segment, a small selected shadow and clear current-page semantics. It reflows to a full-width three-column group on mobile. The particular destination names and relative column widths remain surface decisions.

### Settings switches
A 42px by 26px track contains a 20px circular thumb. Checked state uses accent fill and moves the thumb by 16px. The associated label provides the larger interaction area. Focus outlines the whole label; disabled settings use 0.64 opacity. Thumb movement is 160ms ease-out only when reduced motion is not requested.

### Expandable rows
Rows align an icon, a wrapping title with time, a written status and a disclosure indicator. Hover lightly changes the row background. Opening a row reveals detail within the same group and rotates its disclosure icon. On mobile, the status moves beneath the title while the disclosure stays at the right. The pattern is reusable; chronological ordering is specific to the activity surface.

## Do's and Don'ts

### Do:
- **Do** switch all semantic color roles together when appearance changes.
- **Do** keep text labels, focus feedback and the meaning of status visible.
- **Do** use the shared system text family and tabular numerals for time and counts.
- **Do** let translated titles wrap and reflow status beneath the title on narrow screens.
- **Do** preserve the existing safe-area-aware mobile shell and reduced-motion preference.

### Don't:
- **Don't** use decorative gradients or invented live indicators.
- **Don't** replace status text with color alone.
- **Don't** turn every list row into a floating card.
- **Don't** promote the Automation page composition into a rule for every product surface.

Source of truth: `src/automation-design.css`, inherited interface typography in `src/workspace-shell.css`, and the Automation Hub, Brief and Control Centre component styles. The sidecar extends these tokens with interactive specimen CSS, motion, focus/depth details and responsive metadata.
