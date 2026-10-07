import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5374';
const batch = process.env.ZENTRA_QA_BATCH || 'confirmation';
const output = fileURLToPath(new URL('../../.qa/calendar-i18n/', import.meta.url));
await mkdir(output, { recursive: true });

// Independent expectations: missing translations cannot pass by comparing t() with itself.
const copy = {
  fr: { locale: 'fr-CH', day: 'Jour', week: 'Semaine', month: 'Mois', today: 'Aujourd’hui', newTitle: 'Nouveau rendez-vous', editTitle: 'Modifier le rendez-vous', start: 'Début', end: 'Fin', title: 'Titre', location: 'Lieu', notes: 'Notes', save: 'Enregistrer le rendez-vous', titleError: 'Donnez un titre de 1 à 200 caractères, par exemple « Visite chez le client ».', dateError: 'Choisissez la date de début dans le calendrier.', timeError: 'La fin doit être après le début. Si le rendez-vous finit le lendemain, changez aussi la date de fin.', deleteTitle: 'Supprimer ce rendez-vous ?', delete: 'Supprimer le rendez-vous', visit: 'Visite / intervention', scheduled: 'Planifié' },
  de: { locale: 'de-CH', day: 'Tag', week: 'Woche', month: 'Monat', today: 'Heute', newTitle: 'Neuer Termin', editTitle: 'Termin bearbeiten', start: 'Beginn', end: 'Ende', title: 'Titel', location: 'Ort', notes: 'Notizen', save: 'Termin speichern', titleError: 'Geben Sie einen Titel mit 1 bis 200 Zeichen ein, zum Beispiel «Besuch beim Kunden».', dateError: 'Wählen Sie das Startdatum im Kalender.', timeError: 'Das Ende muss nach dem Beginn liegen. Wenn der Termin am nächsten Tag endet, ändern Sie auch das Enddatum.', deleteTitle: 'Diesen Termin löschen?', delete: 'Termin löschen', visit: 'Besuch / Einsatz', scheduled: 'Geplant' },
  it: { locale: 'it-CH', day: 'Giorno', week: 'Settimana', month: 'Mese', today: 'Oggi', newTitle: 'Nuovo appuntamento', editTitle: 'Modifica appuntamento', start: 'Inizio', end: 'Fine', title: 'Titolo', location: 'Luogo', notes: 'Note', save: 'Salva appuntamento', titleError: 'Inserisci un titolo da 1 a 200 caratteri, ad esempio «Visita dal cliente».', dateError: 'Scegli la data di inizio nel calendario.', timeError: 'La fine deve essere successiva all’inizio. Se l’appuntamento termina il giorno dopo, modifica anche la data di fine.', deleteTitle: 'Eliminare questo appuntamento?', delete: 'Elimina appuntamento', visit: 'Visita / intervento', scheduled: 'Pianificato' },
  en: { locale: 'en-CH', day: 'Day', week: 'Week', month: 'Month', today: 'Today', newTitle: 'New appointment', editTitle: 'Edit appointment', start: 'Start', end: 'End', title: 'Title', location: 'Location', notes: 'Notes', save: 'Save appointment', titleError: 'Enter a title of 1 to 200 characters, for example “Client visit”.', dateError: 'Choose the start date in the calendar.', timeError: 'The end must be after the start. If the appointment ends the next day, also change the end date.', deleteTitle: 'Delete this appointment?', delete: 'Delete appointment', visit: 'Visit / intervention', scheduled: 'Planned' },
};
const localDate = iso => new Date(`${iso}T12:00:00`);
const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDate = (iso, amount) => { const date = localDate(iso); date.setDate(date.getDate() + amount); return isoDate(date); };
const shiftMonth = (iso, amount) => { const date = localDate(`${iso.slice(0, 7)}-01`); date.setMonth(date.getMonth() + amount); return isoDate(date); };
const formatDate = (iso, locale) => new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(localDate(iso));
const formatMonth = (iso, locale) => { const text = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(localDate(iso)); return text.charAt(0).toUpperCase() + text.slice(1); };
const weekRange = (iso, locale) => { const monday = shiftDate(iso, -((localDate(iso).getDay() + 6) % 7)); return `${formatDate(monday, locale)} – ${formatDate(shiftDate(monday, 6), locale)}`; };
const fixtureState = page => page.evaluate(() => ({ today: window.agendaFixture.today, writes: window.agendaFixture.writes, attempts: window.agendaFixture.attempts, deletes: window.agendaFixture.deletes, deleteAttempts: window.agendaFixture.deleteAttempts, events: structuredClone(window.agendaFixture.stored.agendaEvents) }));
const rawFields = ['title', 'location', 'notes', 'startDate', 'endDate', 'startTime', 'endTime', 'allDay', 'kind', 'status', 'projectId', 'employeeId'];
const fields = row => Object.fromEntries(rawFields.map(key => [key, row[key]]));
const results = [];
const startedAt = new Date().toISOString();
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });

async function writeReport() {
  const report = { batch, startedAt, finishedAt: new Date().toISOString(), origin, engine: 'chromium', channel: process.platform === 'win32' ? 'msedge' : 'chromium', fixtureOnly: true, productionBackendVerified: false, expectedCases: 8, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, writes: results.reduce((sum, result) => sum + (result.finalState?.writes || 0), 0), deletes: results.reduce((sum, result) => sum + (result.finalState?.deletes || 0), 0), pageErrors: results.flatMap(result => result.pageErrors), results };
  await writeFile(`${output}/proof.json`, JSON.stringify(report, null, 2));
  return report;
}

try {
  for (const language of ['fr', 'de', 'it', 'en']) for (const [width, height, theme] of [[1280, 960, 'light'], [390, 844, 'dark']]) {
    const labels = copy[language];
    const name = `${language}-${width}-${theme}`;
    const result = { name, language, locale: labels.locale, width, height, theme, navigation: [], validationErrors: [], pageErrors: [], blockedExternalOrigins: [], screenshots: [], passed: false };
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', error => result.pageErrors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (!result.blockedExternalOrigins.includes(url.origin)) result.blockedExternalOrigins.push(url.origin);
      return route.abort();
    });
    const translate = (source, values) => page.evaluate(async ({ source, values }) => (await import('/src/language.ts')).t(source, values), { source, values });
    async function screenshot(suffix) {
      const dimensions = await page.evaluate(() => ({ pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, modalOverflow: [...document.querySelectorAll('.modal__body')].some(node => node.scrollWidth > node.clientWidth + 1) }));
      assert.deepEqual(dimensions, { pageOverflow: false, modalOverflow: false }, `${name}: horizontal overflow`);
      const path = `${output}/${batch}-${name}-${suffix}.png`;
      await page.screenshot({ path });
      result.screenshots.push(path);
    }
    async function verifyHeader(mode, action, date) {
      const expected = mode === 'month' ? formatMonth(date, labels.locale) : mode === 'week' ? weekRange(date, labels.locale) : formatDate(date, labels.locale);
      await page.waitForFunction(expected => document.querySelector('.agenda-month-controls strong')?.textContent === expected, expected);
      const actual = await page.locator('.agenda-month-controls strong').innerText();
      result.navigation.push({ mode, action, date, expected, actual });
    }
    async function formLabel(form, field, expected) {
      const actual = await form.locator(`[name="${field}"]`).locator('..').locator('.field__label').innerText();
      assert.ok(actual.startsWith(expected), `${name}: ${field} label ${actual} instead of ${expected}`);
    }
    try {
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&agendaGuided=1&language=${language}&theme=${theme}`);
      await page.waitForFunction(() => Boolean(window.agendaFixture));
      result.languageState = await page.evaluate(async () => { const language = await import('/src/language.ts'); return { ...language.getLanguageState(), locale: language.getAppLocale(), documentLang: document.documentElement.lang, theme: document.documentElement.dataset.appTheme }; });
      assert.equal(result.languageState.ready, true);
      assert.equal(result.languageState.language, language);
      assert.equal(result.languageState.pending, null);
      assert.equal(result.languageState.failed, null);
      assert.equal(result.languageState.locale, labels.locale);
      assert.equal(result.languageState.documentLang, labels.locale);
      assert.equal(result.languageState.theme, theme);
      // This existing fixture clones data before mobile-harness assigns its scope.
      // Align only the synthetic stored snapshot with the harness's literal scope.
      await page.waitForFunction(() => typeof window.__qaAgendaRefresh === 'function');
      result.fixtureContext = await page.evaluate(async () => {
        const initialStoredScope = window.agendaFixture.stored.workNotesScope ?? null;
        window.agendaFixture.stored.workNotesScope ??= 'qa-preview-company';
        await window.__qaAgendaRefresh();
        return { initialStoredScope, alignedScope: window.agendaFixture.stored.workNotesScope };
      });
      assert.equal(result.fixtureContext.alignedScope, 'qa-preview-company');
      const guide = page.getByRole('button', { name: await translate('Fermer le guide automatique'), exact: true });
      if (await guide.isVisible()) await guide.click();
      await page.getByRole('button', { name: await translate('Aller à un écran'), exact: true }).click();
      await page.getByRole('searchbox', { name: await translate('Rechercher un écran') }).fill(await translate('Agenda'));
      await page.locator('.navigation-palette__results button').filter({ has: page.getByText(await translate('Agenda'), { exact: true }) }).click();
      await page.locator('.agenda-layout').waitFor();
      const initial = await fixtureState(page);
      result.today = initial.today;
      assert.equal(initial.events.length, 0, 'fresh synthetic fixture');
      if (width < 860) await page.locator('.agenda-options summary').click();
      const views = page.locator('.agenda-display-switch');
      for (const expected of [labels.day, labels.week, labels.month]) assert.equal(await views.getByRole('button', { name: expected, exact: true }).count(), 1, `${name}: translated view button ${expected}`);
      const previous = page.getByRole('button', { name: await translate('Période précédente'), exact: true });
      const next = page.getByRole('button', { name: await translate('Période suivante'), exact: true });
      const todayButton = page.getByRole('button', { name: labels.today, exact: true });
      for (const [mode, button] of [['month', labels.month], ['week', labels.week], ['day', labels.day]]) {
        await todayButton.click();
        await views.getByRole('button', { name: button, exact: true }).click();
        assert.equal(await page.locator('.agenda-main-grid').getAttribute('data-display'), mode);
        await verifyHeader(mode, 'initial/today', initial.today);
        await previous.click();
        const priorDate = mode === 'month' ? shiftMonth(initial.today, -1) : shiftDate(initial.today, mode === 'week' ? -7 : -1);
        await verifyHeader(mode, 'previous', priorDate);
        await next.click();
        await verifyHeader(mode, 'next/restored', mode === 'month' ? `${initial.today.slice(0, 7)}-01` : initial.today);
        await next.click();
        await verifyHeader(mode, 'next', mode === 'month' ? shiftMonth(initial.today, 1) : shiftDate(initial.today, mode === 'week' ? 7 : 1));
        await todayButton.click();
        await verifyHeader(mode, 'today/reset', initial.today);
      }
      if (width < 860) await page.locator('.agenda-options summary').click();
      assert.equal((await fixtureState(page)).attempts, 0, 'navigation cannot write');
      await page.getByRole('button', { name: await translate('Ajouter un rendez-vous'), exact: true }).click();
      const form = page.getByRole('dialog', { name: labels.newTitle, exact: true });
      await form.waitFor();
      const save = form.getByRole('button', { name: labels.save, exact: true });
      for (const [field, label] of [['title', labels.title], ['location', labels.location], ['startDate', labels.start], ['endDate', labels.end], ['notes', labels.notes]]) await formLabel(form, field, label);
      assert.equal(await form.locator('[name=startDate]').inputValue(), initial.today, 'Today reset selects the actual ISO date');
      await save.click();
      await form.locator('.field__error').waitFor();
      result.validationErrors.push(await form.locator('.field__error').innerText());
      assert.equal(result.validationErrors.at(-1), labels.titleError);
      const create = { title: 'Toute la journée', location: 'Aucun projet', notes: 'Titre\nProjet\nToute la journée\nDonnées client — éà αβ', startDate: initial.today, endDate: shiftDate(initial.today, 1), startTime: '23:45', endTime: '00:15', allDay: false, kind: 'visit', status: 'scheduled', projectId: 'agenda-project', employeeId: 'agenda-person' };
      await form.locator('[name=title]').fill(create.title);
      await form.locator('[name=startDate]').fill('');
      await save.click();
      await form.locator('.field__error').waitFor();
      result.validationErrors.push(await form.locator('.field__error').innerText());
      assert.equal(result.validationErrors.at(-1), labels.dateError);
      await form.locator('[name=startDate]').fill(initial.today);
      await form.locator('[name=endDate]').fill(initial.today);
      await form.locator('[name=endTime]').fill('08:00');
      await save.click();
      await form.locator('.field__error').waitFor();
      result.validationErrors.push(await form.locator('.field__error').innerText());
      assert.equal(result.validationErrors.at(-1), labels.timeError);
      assert.equal((await fixtureState(page)).attempts, 0, 'validation cannot call save');
      await form.locator('[name=startTime]').fill(create.startTime);
      await form.getByRole('group', { name: await translate('Définir la durée'), exact: true }).getByRole('button', { name: '30 min', exact: true }).click();
      assert.equal(await form.locator('[name=endDate]').inputValue(), create.endDate);
      assert.equal(await form.locator('[name=endTime]').inputValue(), create.endTime);
      await form.locator('[name=location]').fill(create.location);
      await form.locator('[name=notes]').fill(create.notes);
      await form.locator('.agenda-editor-more summary').click();
      assert.equal(await form.locator('[name=kind] option[value=visit]').innerText(), labels.visit);
      assert.equal(await form.locator('[name=status] option[value=scheduled]').innerText(), labels.scheduled);
      await form.locator('[name=kind]').selectOption(create.kind);
      await form.locator('[name=status]').selectOption(create.status);
      await form.locator('[name=projectId]').selectOption(create.projectId);
      await form.locator('[name=employeeId]').selectOption(create.employeeId);
      result.editorSummary = await form.locator('.agenda-time-summary').innerText();
      assert.ok(result.editorSummary.includes(formatDate(create.startDate, labels.locale)));
      assert.ok(result.editorSummary.includes(formatDate(create.endDate, labels.locale)));
      await screenshot('editor');
      await save.click();
      await form.waitFor({ state: 'hidden' });
      const saved = await fixtureState(page);
      assert.equal(saved.writes, 1);
      assert.equal(saved.attempts, 1);
      assert.equal(saved.events.length, 1);
      assert.deepEqual(fields(saved.events[0]), create, 'raw customer values, ISO dates, times and enums');
      result.created = fields(saved.events[0]);
      const row = page.locator(`[data-event-id="${saved.events[0].id}"]`);
      assert.equal(await row.locator('.agenda-row__content strong').innerText(), create.title);
      assert.ok((await row.locator('.agenda-row__content p').innerText()).includes(create.location));
      await screenshot('saved-day');
      await row.getByRole('button', { name: await translate('Modifier « {title} »', { title: create.title }), exact: true }).click();
      const edit = page.getByRole('dialog', { name: labels.editTitle, exact: true });
      await edit.waitFor();
      for (const field of ['title', 'location', 'notes', 'startDate', 'endDate', 'startTime', 'endTime', 'kind', 'status', 'projectId', 'employeeId']) assert.equal(await edit.locator(`[name="${field}"]`).inputValue(), create[field], `${name}: edit preserves ${field}`);
      const updated = { ...create, title: 'Version enregistrée', location: 'Personne indisponible', notes: 'Ma saisie\nNotes client conservées — à Genève', startTime: '22:30', endTime: '00:45', kind: 'deadline' };
      for (const field of ['title', 'location', 'notes', 'startTime', 'endTime']) await edit.locator(`[name="${field}"]`).fill(updated[field]);
      await edit.locator('[name=kind]').selectOption(updated.kind);
      await edit.getByRole('button', { name: labels.save, exact: true }).click();
      await edit.waitFor({ state: 'hidden' });
      const edited = await fixtureState(page);
      assert.equal(edited.writes, 2);
      assert.equal(edited.attempts, 2);
      assert.equal(edited.events.length, 1);
      assert.equal(edited.events[0].id, saved.events[0].id);
      assert.deepEqual(fields(edited.events[0]), updated);
      result.edited = fields(edited.events[0]);
      assert.equal(await row.locator('.agenda-row__content strong').innerText(), updated.title);
      await row.getByRole('button', { name: await translate('Supprimer « {title} »', { title: updated.title }), exact: true }).click();
      const remove = page.getByRole('dialog', { name: labels.deleteTitle, exact: true });
      await remove.waitFor();
      assert.equal(await remove.locator('.agenda-action-summary strong').innerText(), updated.title);
      assert.equal(await remove.getByText(updated.location, { exact: true }).count(), 1);
      assert.equal(await remove.locator('.agenda-action-summary p').last().innerText(), updated.notes);
      await remove.getByRole('button', { name: labels.delete, exact: true }).click();
      await remove.waitFor({ state: 'hidden' });
      result.finalState = await fixtureState(page);
      assert.equal(result.finalState.writes, 2);
      assert.equal(result.finalState.deletes, 1);
      assert.equal(result.finalState.deleteAttempts, 1);
      assert.equal(result.finalState.events.length, 0);
      assert.equal(await row.count(), 0);
      assert.deepEqual(result.pageErrors, []);
      result.passed = true;
    } catch (error) {
      result.failure = String(error.stack || error);
      result.finalState = await fixtureState(page).catch(() => null);
      if (!page.isClosed()) await page.screenshot({ path: `${output}/${batch}-${name}-failure.png` }).then(() => result.screenshots.push(`${output}/${batch}-${name}-failure.png`)).catch(() => {});
      process.exitCode = 1;
    } finally {
      results.push(result);
      await writeReport();
      console.log(JSON.stringify({ case: name, passed: result.passed, writes: result.finalState?.writes, deletes: result.finalState?.deletes, failure: result.failure?.split('\n')[0] }));
      await page.close();
    }
  }
} finally {
  const report = await writeReport();
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, writes: report.writes, deletes: report.deletes, proof: `${output}/proof.json` }));
  await browser.close();
}
