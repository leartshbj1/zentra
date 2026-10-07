# Gestion visual tour — updated 7 October 2026

The retained /demo-facture route shows real screenshots of Gestion with the fictional company **Atelier du Léman**. It remains a visual visit, with no account, editable company data or live service required.

## Current captures

304 WebP assets cover **19 modules**, including Notes, in French, German, Italian and English. Each module has desktop (1440 × 960) and phone (390 × 844) views in light and dark themes. The renderer is the production WorkspaceApp and its production styles, based on Gestion 1.90.15 at commit 0d2571a741883add178b485e8a1ad4d0222d4204, with the calendar localization correction retained locally at 596a3f2ba1b65e2fe599a7996bd638d104a0d53d. This website update does not publish or install that native application correction.

The existing mobile-harness and its synthetic fixtures provide all displayed clients, projects, documents, staff and Automation activity. The capture runner uses fresh contexts, blocks external HTTP/WebSocket requests and checks company, language, theme, the loaded screen, closed mobile navigation, absence of page overflow and broken images. The main capture batch passed 304/304 checks, with no page or console errors and no external request attempted. No real company, mailbox, financial record, payment or cloud state was accessed or written.

The 16 Agenda captures were replaced by a separate verified batch with a fictional visit to Résidence Bellevue on 7 October 2026, 09:00–10:00, linked to its project. The guided fixture was prepared in memory with the correct qa-preview-company scope; writes and deletes remained zero. Desktop Settings shows Appearance; phone Settings shows its section menu. Reports selects the demonstration project. Computed and CDP font checks confirmed the actual Segoe UI face on both device sizes.

Only encoding changed: WebP quality 94, no compositing, erasing, filtering or redrawing. The current assets occupy approximately 13.6 MB together; the largest image is below 100 kB. Only the selected capture is mounted and requested. docs/app-tour-assets.json records every shipped file, dimensions, size and original PNG/WebP SHA-256 values. docs/app-tour-provenance.json records source hashes and the capture matrix. Existing older image URLs are retained for compatibility, but the visit uses /tour/gestion/current/.

Capture scripts, original PNGs and detailed evidence remain in D:/Codex-Zentra-Temporary/2026-10-07/tour-capture-tools. The two independent reports are complete-304/result.json and agenda-filled-16/result.json. App calendar browser evidence is in calendar-i18n/.qa/calendar-i18n/proof.json. These local paths describe retained evidence, not public downloads.

## Interaction and localization

The desktop menu, phone selector and hash links select the same 19 stable module identifiers. Light/dark controls select actual captures and persist a separate visit preference, following the system preference initially. Device controls override the responsive default. Image enlargement uses a native dialog, Close/Escape and focus restoration. A failed image exposes Retry. Reduced motion disables image arrival and animated scrolling.

Navigation, controls and explanations use the existing four-language site catalogues. Synthetic company names and text entered as user data are deliberately preserved. The English images represent a Swiss demonstration company; they are not a claim that the experimental US edition is commercially or fiscally validated.

## Product limits and design inheritance

Screenshots establish the appearance of the real UI with synthetic records. They do not prove native installation, physical-device behavior, live multi-device synchronization or financial correctness. Payroll, banking, accounting, optional Automation and linked Support retain the limits stated alongside their images.

The visit preserves its approved Experience composition, Studio typography and green identity. New local screen-surface variables follow the app themes; the rest of the website retains its current appearance. The manual detector reported only advisory inherited local typography/radius/backdrop values already documented in .impeccable/surfaces/app-tour.md. Existing design-sidecar and null surface-target metadata drift is retained and reported here; it was not repaired as a side effect of this request.
