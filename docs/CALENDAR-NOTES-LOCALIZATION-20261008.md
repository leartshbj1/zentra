# Calendar, Notes and Fixed assets — 8 October 2026

This CH-only correction branch starts at native 1.90.15, commit 596a3f2ba1b65e2fe599a7996bd638d104a0d53d. It contains no experimental US runtime or migration, no database change and no native binary release. Current implementation checkpoint: d5f5d494a665f723b7dba28e54670c6a7edb77a2.

## Changes

- Calendar: task and project milestone source badges follow FR/DE/IT/EN. Title sorting uses the active locale rather than a constant fr-CH collator. Existing ISO dates and stored titles are preserved.
- Notes: the four reviewed Notes implementation/test/style/translation files are integrated from design checkpoint 131cbb54; unrelated global workspace changes are not imported. The 200-character title limit, autosave/reopen and read-only behavior are retained.
- Fixed assets: the production panel responds to live language changes and uses a dedicated 59-message catalogue. Asset names, references, amounts, depreciation calculations and storage are unchanged.

## Files

Added: desktop/src/FixedAssetsPanel.i18n.test.tsx, desktop/src/translationsFixedAssets.ts.

Modified: desktop/src/Agenda.i18n.test.tsx, desktop/src/agenda.ts, desktop/src/translationsAgenda.ts, desktop/src/NotesScreen.tsx, desktop/src/NotesScreenLifecycle.test.tsx, desktop/src/notes.css, desktop/src/translationsNotes.ts, desktop/src/FixedAssetsAccountPreparation.test.tsx, desktop/src/FixedAssetsPanel.test.tsx, desktop/src/FixedAssetsPanel.tsx, desktop/src/languageCatalogCoverage.test.ts, desktop/src/translations.ts.

## Executed validation

The assembled CH clone passed **172 tests in 8 actual test files**: Agenda.i18n (34), agenda (13), agendaForm (29), agendaBridge (5), workNotes (57), NotesScreenLifecycle (15), workNotesBridge (10), FixedAssetsPanel.i18n (9). Nonexistent extra filenames in the command are not evidence of testing. TypeScript --noEmit and Vite production build exited 0; existing large-chunk warnings remain.

The assembled CH clone additionally passed **41 tests in 3 files**: FixedAssetsPanel (14), FixedAssetsAccountPreparation (25) and languageCatalogCoverage (2). The independent Fixed assets source and assembled US frontend also passed 63 targeted asset/catalogue tests, separately from the CH-clone tests. These do not constitute a production, native-installation, physical-device, financial-engine or multi-device test. Screenshots for the website use only fictional records and readonly harness adapters.

## Delivery limits

The website visit can publish these refreshed captures independently. This branch still needs integration into the next installable native release and distribution through the existing release workflow. No Windows/macOS/iOS/Android installer is claimed to have been published by this correction checkpoint. Version number 1.90.15 is deliberately unchanged until release preparation.
