import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { Workspace } from '../src/types';

// Synthetic writes; production bridge/native acknowledgement is tested separately.
export function installEntityRecoveryFixture(workspace: () => Workspace, failAfterWrite = true) {
  const track = (key: string, value: unknown) => {
    const events = JSON.parse(sessionStorage.getItem(key) || '[]');
    events.push(value);
    sessionStorage.setItem(key, JSON.stringify(events));
  };
  desktopApi.loadWorkspace = async () => {
    track('qa-entity-reads', {});
    if (sessionStorage.getItem('qa-entity-block-reads') === '1') {
      throw Error('La lecture est momentanément indisponible.');
    }
    return structuredClone(workspace());
  };
  desktopApi.createEntity = async (entity, input) => {
    if (entity !== 'clients')
      throw Error(
        'Cette recette concerne uniquement des clients synthétiques.',
      );
    track('qa-entity-writes', input);
    workspace().clients.push({
      id: crypto.randomUUID(),
      name: String(input.contactPerson),
      company: String(input.company),
      email: String(input.email),
      phone: String(input.phone),
      address: String(input.addressLine1),
      addressLine1: String(input.addressLine1),
      buildingNumber: String(input.addressLine2),
      postalCode: String(input.postalCode),
      city: String(input.city),
      canton: String(input.canton),
      country: String(input.country),
      notes: String(input.notes),
      uidNumber: '',
      archivedAt: null,
    });
    if (failAfterWrite) sessionStorage.setItem('qa-entity-block-reads', '1');
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
}
