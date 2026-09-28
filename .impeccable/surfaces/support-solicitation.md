# Support — Démarchage

Mode: Operate. Ordinary extension of the existing Zentra Studio Support workspace, documented on 28 September 2026. [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md) and [design.json](../design.json) are preserved.

## Direction contract
THESIS: Keep unsolicited sales proposals available without interrupting customer support. A message leads to one calm choice: ignore, express interest, or request no further contact.

OWN-WORLD: Inherit Support's forest green, white reading surface, pearl canvas, fine rules and existing text/control scale. No new cards, decorative gradients or urgency colour for ordinary sales mail.

STORY: Open the Démarchage folder, read the low-priority proposal and choose an action. Ignore keeps the message and can be reversed. Interest and STOP reveal an editable response with the recipient and sender returned by the connected tool; sending requires the explicit send action. STOP requests no further contact and does not technically block the sender. Settings belong to the workspace, with alerts off by default in open Support.

FIRST VIEWPORT: Existing folder/list/detail composition. Démarchage is directly visible among folders. A compact silent-state row links to preferences. Three plain actions sit after the message. Mobile shows one reading pane, with wrapped controls and a full-width inline composer.

FORM: Narrow, precisely specified extension of the incumbent Studio composition; no concept tournament or raster asset required.

FINISH: the [independent finish review](../review/support-solicitation/finish-review.md) resolves the single P2 saved-status correction with disposition `ship` for that correction. The [documentation record](../review/support-solicitation/documentation.md) records the source, screenshots, supplied checks and remaining limits. No new product raster is shipped, and the existing design system is unchanged.

## Implemented expression

[application.tsx](../../components/support/application.tsx) exposes Démarchage among the main category folders, with a quiet notification row and a link to workspace preferences. It preserves the index/list/reading composition; mobile uses the existing single reading pane. The folder remains an internal Support view, without implying a provider-mailbox move.

[solicitation-panel.tsx](../../components/support/solicitation-panel.tsx) places Ignorer, Intéressé and STOP after the message. The reply opens inline with recipient, sender, subject and editable body, copy/close controls and a deliberate send action. An uncertain send is labelled for verification and has no automatic resend. Read-only, unavailable, stale and already-submitted states keep the send action unavailable.

Workspace preferences cover alerts, permission to reply, reply language, signature and editable interest/STOP templates in French, German, Italian and English. This is reply-template language support, not a claim that every interface string is translated. Administrators manage the shared preferences. Editing or restoring a template, including a programmatic reply-language change, clears the saved confirmation until a successful save.

The [local styles](../../app/support/support.css) reuse Support's existing `--s-*` roles, system text, white reading surface and separators. The action group wraps and its buttons have a 44 px minimum height. The inline editor adds no card or decorative shadow. Preferences are limited to 780 px; below 600 px, reply controls use 16 px input text and footer/save actions span the available width. These are surface-specific compositions, not new global tokens.

## Evidence and limits

[report.json](../review/support-solicitation/report.json) records successful local Edge demo journeys at 1440, 390 and 320 px: ignore/restore, interest, editing/closing, simulated STOP, settings and templates, with no reported JavaScript error. The document-overflow assertion is made in the final templates state; it is not an exhaustive overflow assertion for every intermediate view. The script also verifies save → confirmation → restore → no confirmation → save → confirmation. The supplied aggregate result is 344 passing tests, reported by the implementation lead and not rerun during documentation.

The final reviewer reopened eight recaptured message/reply/settings/template screenshots and found no regression from the P2 correction. The verdict covers that one correction. Source code moves focus into the reply subject, but this evidence set does not establish a complete keyboard or assistive-technology audit.

All browser evidence uses `/support/demo` and fictitious data. No email was sent. Live AI classification remains pending; connected-provider delivery, authenticated production use and publication are not established by this document. This handoff documents the implementation before publication, not a live deployment.
