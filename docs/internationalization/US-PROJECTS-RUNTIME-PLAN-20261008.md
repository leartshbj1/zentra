# US projects — incremental plan, 8 October 2026

The initial architecture audit is `AUDIT.md`. This phase follows the sales and export runtime at commit `42d516ad70d8547a8914f19daa5597b5ce2d00b9`. It does not activate the US edition in production or alter Swiss workspaces.

## Gap confirmed in source

The runtime accepts an optional project identifier on an estimate, but the real server binding has no project register. The native app's project menus still use the Swiss SQLite workspace. A copied visual folder would not make the US relationship durable.

## One authority

Add ERP schema 3, containing the existing schema 2 purchase register plus projects and its numbering counter. Projects use the existing workspace CAS revision, receipts, change records and sync events. No second project database or synchronization loop is introduced. Schema 1 and 2 objects, receipts and archived events retain their exact shapes.

Only an explicit `save_projects` transaction may promote an old book. Previously referenced project identifiers must be materialized with approved names and customer relationships in that same transaction, or promotion is refused with `legacy_project_review_required`. No old reference is invented, discarded or silently reassigned.

`INTERNATIONAL_US_PROJECTS_V3_ENABLED=true` requires the existing purchasing capability and explicit client schema 3. Both server flags remain closed by default. A new migration is generated with the installed Supabase CLI, tested locally, and remains unapplied to production. Purchase invariants must hold for both schemas 2 and 3.

## Deliverable

- Project creation, editing and archiving: customer, name, dates, net budget, notes and links to existing supplier bills.
- An active project for the chosen customer can be selected on a quote. Historical documents remain accessible after archiving.
- The dossier derives quotes, issued invoices, payments and associated purchases from the one ERP book. Quote values, invoiced values and received payments remain separate; converted quotes are not counted again as revenue.
- A public dossier export in JSON, CSV, HTML and PDF uses the existing authenticated export port, exact amounts and four languages.
- A responsive project surface shares the existing design and handles conflicts, receipt recovery, permission denial and workspace changes.

Project notes and planned dates are metadata, not a new task planner. Vendor-bill links reference authorized bookkeeping records; this phase does not add original attachment storage, automatic supplier ingestion, sales orders or credit notes. New invoice issuance remains closed without the trusted tax provider; a private fictional TEST issuer is used only in tests.

## Validation and boundaries

Test exact input and stored shapes, hostile JSON, scope and permissions, money and real dates, immutable numbering/history, conflicts, idempotence, explicit legacy review, schema/capability transitions, archived links and unique supplier-bill associations. Execute the new migration in PGLite with schema 1/2 regression tests, tax TEST issuance and all purchase guards. Run the existing CH and international tests, typecheck, changed-file lint and production build. Browser QA covers four languages, themes and narrow screens; it is not evidence of native or production multi-device capacity.

Next native milestone: align the schema 1/2/3 TS and Rust contracts, dispatch US device admission explicitly, mount one US session at the workspace root and feed the normal menus. Do not create a CHF license to bypass US admission or import private server modules into a native webview.

## Rollback

Stop new writes by closing the schema 3 flag. Existing schema 3 workspaces must remain intentionally unavailable to incapable clients rather than being downgraded or emptied. Preserve their records, receipts and events for reactivation with a capable client. Historical migration files are not rewritten. Production migration and activation require a concrete reviewed proposal and explicit approval.
