# Dashboard workflow

Mode: Operate. Continue the approved Apple-inspired, green Zentra workspace. This is a focused part of the full-app redesign; it does not claim the other screens complete.

## Direction contract
THESIS: Read the financial position, start work, then follow the items needing attention. Creation must not be buried below an empty project panel.

OWN-WORLD: Retain the existing opaque paper/graphite surfaces, system typography, forest-green actions and paired light/dark tokens. Compact controls form one working toolbar, not a second gallery of cards.

STORY: The user sees their actual figures, finds their chosen actions, and opens the exact invoice from its due-date row. Company data, permissions and user-selected shortcuts remain authoritative.

FIRST VIEWPORT: On desktop with activity, financial summary first, then a full-width personalized creation toolbar. Automation and follow-up remain together below; setup, active projects and due dates follow. On phones the existing dedicated home layout remains: balance, Automation summary when present, chosen actions, follow-up, available projects, revenue and collapsible setup. Shortcuts use two columns at ordinary text size and one column with enlarged text on narrow phones. An account without activity retains its setup-first path.

FORM: Local extension of the established workspace, no new visual-world selection. Inspiration: Apple HIG layout, Things' task-focused hierarchy, Linear's 2026 reduction of competing navigation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Dashboard contracts

- Reading order and keyboard order agree. Desktop creation controls are a wrapping toolbar with a 48px minimum height; they must remain ahead of an empty project panel. Keep the user's chosen shortcuts, prerequisite handling and read-only guards. Opening a due-date row targets that exact invoice without changing the source invoice order.
- At widths up to 480px with enlarged text, give the dashboard title the available width and stack creation shortcuts in one column. Preserve readable words and the requested text size. At 150–200% text, the personalized dock places retained shortcuts in two columns and Menu on its own row; every destination must remain visible and reachable by touch and keyboard, with enough scroll clearance to read the page content.
- On the phone balance and revenue rows, currency may wrap separately from its number. Keep digits, separators and decimals together, retain locale formatting, and keep different currencies separate. The numeric group has a local overflow fallback for exceptionally long values; document scrollWidth alone does not establish legibility. Acceptance requires reading the complete amount within its surface, including at 320px with 200% text.
- Translate the changed project and due-date headings, list action, empty states and fallback labels through the existing French/German/Italian/English localization system. Preserve company and client names, project names, invoice titles and invoice numbers as user content. This is a scoped dashboard language contract, not a claim of complete application translation.

## Evidence and review status

The browser fixture set contains six screen configurations and eight captures: 1440px French in light/dark, 1024px English dark, 390px Italian light and French dark, 320px German light at 200% text, plus the selected-invoice interaction and a [scrolled viewport showing the enlarged balance](../review/dashboard-workflow/320-enlarged-balance.png). All use synthetic data. [report.json](../review/dashboard-workflow/report.json) records the layout measurements, frontend read-only checks and selected invoice F-2026-001. The enlarged-text checks record three intact numeric groups within the 320px viewport, five wholly visible dock controls at least 44px high, four touch destinations and keyboard access to Home and Menu. The supplemental viewport shows the complete CHF 3'863.49 balance above the fixed dock; the full-page capture alone had the dock over that amount. These targeted checks do not establish every possible amount or navigation path.

The [review](../review/dashboard-workflow/review.md) requested a correction batch for enlarged text, money, navigation and dashboard translations. That batch is implemented and the named captures have been refreshed. Documentation records the reading order and these contracts. The fresh verdict is **ship**, with all five scored fixes resolved; this is not a whole-surface certification. These artifacts establish no native installation, multi-device concurrency, publication or whole-app completion.
