import { prepareMailDocuments } from './mail-documents';
import { calendarAppointment } from '@/lib/appointments/extraction';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openImapMailbox, encodeImapCredentials, decodeImapCredentials } from './infomaniak-imap';
import { mailExternalId } from './infomaniak';

const mock = vi.hoisted(() => ({
  options: {} as any,
  connect: vi.fn(), mailboxOpen: vi.fn(), fetchAll: vi.fn(), fetchOne: vi.fn(), close: vi.fn(), on: vi.fn(),
}));
vi.mock('imapflow', () => ({ ImapFlow: class {
  constructor(options: unknown) { mock.options = options; }
  connect = mock.connect; mailboxOpen = mock.mailboxOpen; fetchAll = mock.fetchAll;
  fetchOne = mock.fetchOne; close = mock.close; on = mock.on;
} }));

beforeEach(() => {
  vi.resetAllMocks();
  mock.connect.mockResolvedValue(undefined);
  mock.mailboxOpen.mockResolvedValue({ uidNext: 105, uidValidity: BigInt(900) });
  mock.fetchAll.mockResolvedValue([]);
});

describe('Connexion Infomaniak IMAP', () => {
  it('impose TLS, le serveur officiel, une lecture seule et aucune journalisation', async () => {
    const mail = await openImapMailbox('inbox@example.test', ' space preserved ');
    expect(mock.options).toMatchObject({ host: 'mail.infomaniak.com', port: 993, secure: true, auth: { user: 'inbox@example.test', pass: ' space preserved ' }, logger: false, emitLogs: false, logRaw: false, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
    expect(mock.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(mail).toMatchObject({ mailboxId: 'imap:inbox@example.test', folderId: 'imap:INBOX:900', nextUid: 105 });
    mail.close(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it.each([['bad email', 'password'], ['a@example.test', ''], ['a@example.test', 'pass\r\nLOGIN']])('refuse des identifiants invalides sans ouvrir de socket', async (address, password) => {
    await expect(openImapMailbox(address, password)).rejects.toMatchObject({ status: 422 });
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it('masque le détail serveur et ferme la connexion après un refus', async () => {
    mock.connect.mockRejectedValue(Object.assign(new Error('secret-password raw server response'), { authenticationFailed: true }));
    await expect(openImapMailbox('a@example.test', 'secret-password')).rejects.toThrow('Infomaniak refuse ce mot de passe');
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it('ne révèle pas les données d’une erreur réseau', async () => {
    mock.connect.mockRejectedValue(new Error('secret-server-error'));
    await expect(openImapMailbox('a@example.test', 'password')).rejects.toThrow('connexion sécurisée');
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it('refuse une identité IMAP changée avant de lire des messages', async () => {
    await expect(openImapMailbox('a@example.test', 'password', 'imap:INBOX:800')).rejects.toMatchObject({ status: 409 });
    expect(mock.fetchAll).not.toHaveBeenCalled(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it('pagine les UID par blocs bornés, traverse les trous et exclut les anciens mails', async () => {
    const mail = await openImapMailbox('a@example.test', 'password');
    mock.fetchAll.mockResolvedValue([{uid: 103, internalDate: new Date('2026-09-21T10:00:00Z')}, {uid: 85}, {uid: 84}]);
    const first = await mail.list(0, 50);
    expect(mock.fetchAll).toHaveBeenCalledWith('85:104', {uid: true, internalDate: true}, {uid: true});
    expect(first.messages.map(x => x.uid)).toEqual(['103', '85']);
    expect(first.count).toBe(20);
    mock.fetchAll.mockResolvedValue([]);
    expect((await mail.list(20, 50)).count).toBe(20);
    expect((await mail.list(40, 50)).count).toBeLessThan(20);
    mock.fetchAll.mockClear();
    expect(await mail.list(60, 50)).toEqual({messages: [], count: 0});
    expect(mock.fetchAll).not.toHaveBeenCalled(); mail.close();
  });
  it('ne récupère aucun historique au moment du branchement', async () => {
    const mail = await openImapMailbox('a@example.test', 'password');
    expect(await mail.list(0, mail.nextUid)).toEqual({messages: [], count: 0});
    expect(mock.fetchAll).not.toHaveBeenCalled(); mail.close();
  });
  it('extrait une facture MIME et son identité sans exposer les octets dans le ticket', async () => {
    const raw = Buffer.from([
      'From: Fournisseur <billing@example.test>', 'Subject: =?UTF-8?Q?Facture_=C3=A0_v=C3=A9rifier?=',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="zentra"', '',
      '--zentra', 'Content-Type: text/plain; charset=utf-8', '', 'Bonjour, voici la facture.',
      '--zentra', 'Content-Type: application/pdf; name="facture.pdf"', 'Content-Disposition: attachment; filename="facture.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.7\nfixture').toString('base64'), '--zentra--', '',
    ].join('\r\n'));
    mock.fetchOne.mockResolvedValueOnce({size: raw.length}).mockResolvedValueOnce({source: raw});
    const mail = await openImapMailbox('a@example.test', 'password');
    const source = await mail.read({uid: '104', date: 1789984800});
    expect(source.subject).toBe('Facture à vérifier');
    expect(source.body).toContain('Bonjour, voici la facture.');
    expect(source.externalId).toBe(await mailExternalId(mail.mailboxId, mail.folderId, '104'));
    expect(source.mail?.attachments).toEqual([{id: '104:0', name: 'facture.pdf', size: 16}]);
    expect(Buffer.from(await mail.attachment('104:0')).toString()).toBe('%PDF-1.7\nfixture');
    expect(JSON.stringify(source)).not.toContain('%PDF');
    expect(mock.fetchOne.mock.calls[1]).toEqual(['104', {source:{start:0,maxLength:12*1024*1024+1},internalDate:true}, {uid:true}]);
    mail.close(); await expect(mail.attachment('104:0')).rejects.toThrow('indisponible');
  });
  it.each(['attachment; filename="confirmation.ics"', 'inline'])('transmet le calendrier MIME %s jusqu’à l’extraction agenda',async disposition=>{
    const ics=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:qa-calendar-1','DTSTART;TZID=Europe/Zurich:20260922T103000','DTEND;TZID=Europe/Zurich:20260922T110000','SUMMARY:Visite confirmee','LOCATION:Visioconference','STATUS:CONFIRMED','END:VEVENT','END:VCALENDAR'].join('\r\n');
    const raw=Buffer.from(['From: client <client@example.test>','Subject: Confirmation de rendez-vous','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="calendar"','','--calendar','Content-Type: text/plain; charset=utf-8','','Rendez-vous confirme le 22 septembre a 10h30.','--calendar','Content-Type: text/calendar; charset=utf-8',`Content-Disposition: ${disposition}`,'Content-Transfer-Encoding: base64','',Buffer.from(ics).toString('base64'),'--calendar--',''].join('\r\n'));
    mock.fetchOne.mockResolvedValueOnce({size:raw.length}).mockResolvedValueOnce({source:raw});
    const mail=await openImapMailbox('a@example.test','password');
    const source=await mail.read({uid:'104',date:null});
    expect(source.mail?.attachmentCount).toBe(1);
    expect(source.mail?.attachments).toHaveLength(1);
    const prepared=await prepareMailDocuments(source,mail.attachment);
    expect(prepared.source.incomplete).toBe(false);
    const event=calendarAppointment(prepared.source.mail!.calendarText!,'Confirmation');
    expect(event).toMatchObject({startDate:'2026-09-22',startTime:'10:30',endTime:'11:00',location:'Visioconference',issues:[]});
    mail.close();
  });
  it('borne les messages avant téléchargement', async () => {
    mock.fetchOne.mockResolvedValue({size: 13 * 1024 * 1024});
    const mail = await openImapMailbox('a@example.test', 'password');
    await expect(mail.read({uid: '104', date: null})).rejects.toThrow('dépasse 12 Mo');
    expect(mock.fetchOne).toHaveBeenCalledOnce(); mail.close();
  });
  it('sépare la configuration IMAP des anciennes clés API', () => {
    expect(decodeImapCredentials('legacy-key')).toBeNull();
    const value = {password:' complete password ', firstUid:105};
    expect(decodeImapCredentials(encodeImapCredentials(value))).toEqual(value);
    expect(() => decodeImapCredentials('zentra-imap-v1:{"password":"secret","firstUid":0}')).toThrow('Reconnectez');
  });
});
