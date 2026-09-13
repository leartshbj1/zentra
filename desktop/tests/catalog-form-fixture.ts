import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
const native = { load: desktopApi.loadWorkspace, save: desktopApi.saveCatalogItem };

export function installCatalogFormFixture(data: Workspace) {
  data.settings!.organization.vatRegistered = true;
  data.settings!.billing.vatRatesBp = [810, 260, 380, 0];
  const stored = JSON.parse(sessionStorage.getItem('catalog-form-store') || 'null') || { catalog_items: [], stock_movements: [] };
  stored.settings = { company_name: 'Entreprise de recette', extra_settings_json: JSON.stringify(data.settings) };
  const state = { stored, attempts: 0, writes: 0, mode: '', blockRead: false, empty: false, omitItem: false, hold: false, release: () => {}, version: 100 };
  const persist = () => sessionStorage.setItem('catalog-form-store', JSON.stringify(stored));
  const version = () => `2026-09-13T12:00:00.${++state.version}Z`;
  data.catalogItems = stored.catalog_items.map((row: Record<string, any>) => ({ ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value])), trackStock: !!row.track_stock }));
  data.stockMovements = stored.stock_movements.map((row: Record<string, any>) => ({ ...row, catalogItemId: row.catalog_item_id }));
  data.stockAvailability = []; data.stockReservationEvents = [];
  Object.assign(window, { catalogFixture: { state, change: (id: string, patch: Record<string, unknown>) => { const row = stored.catalog_items.find((row: any) => row.id === id); Object.assign(row, patch, { updated_at: version() }); persist(); }, persist } });
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { entity: string; id: string; data: Record<string, any>; expectedUpdatedAt?: string }) => {
    if (command === 'get_app_state' || command === 'get_workspace') {
      if (state.blockRead) throw Error('Lecture du catalogue interrompue.');
      if (command === 'get_app_state') return { onboarding_completed: !state.empty };
      return structuredClone({ ...stored, catalog_items: state.omitItem ? [] : stored.catalog_items });
    }
    if (command !== 'update_catalog_item' && !(command === 'create_record' && args.entity === 'catalog_items')) throw Error(`Commande hors recette catalogue : ${command}`);
    state.attempts++;
    if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
    const mode = state.mode; state.mode = '';
    if (mode === 'refuse') throw Error('purchase_cost_cents doit être positif ou nul.');
    const current = stored.catalog_items.find((row: any) => row.id === args.id);
    if (command === 'update_catalog_item' && (!current || current.updated_at !== args.expectedUpdatedAt)) throw Error('La fiche du catalogue a changé. Relisez sa version actuelle.');
    if (command === 'create_record') {
      if (stored.catalog_items.some((row: any) => row.id === args.data.id)) throw Error('Identifiant déjà présent.');
      stored.catalog_items.push({ archived_at: null, ...args.data, track_stock: args.data.track_stock ? 1 : 0, created_at: version(), updated_at: version() });
    } else Object.assign(current, args.data, { track_stock: args.data.track_stock ? 1 : 0, updated_at: version() });
    state.writes++; persist();
    if (mode === 'ack-unreadable' || mode === 'lost-unreadable') state.blockRead = true;
    if (mode === 'lost' || mode === 'lost-unreadable') throw Error('Réponse de la fiche perdue.');
    return structuredClone(command === 'create_record' ? stored.catalog_items.at(-1) : current);
  } } });
  desktopApi.loadWorkspace = native.load; desktopApi.saveCatalogItem = native.save;
}
declare global { interface Window { catalogFixture: { state: any; change: (id: string, patch: Record<string, unknown>) => void; persist: () => void }; __qaCatalogRefresh: () => Promise<void> } }
