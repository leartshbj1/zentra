import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImapFlow as ImapClient } from 'imapflow';
import { openImapMailbox } from './infomaniak-imap';

const transport = vi.hoisted(() => ({ port: 0, timeout: 180, clients: [] as ImapClient[],
  locks: [] as Awaited<ReturnType<ImapClient['getMailboxLock']>>[], productionOptions: [] as Record<string, unknown>[] }));
// Only the test constructor changes transport/timing. Protocol, sockets, locks and
// timeout handling are the installed ImapFlow, with no fake timers or public host.
vi.mock('imapflow', async importOriginal => {
  const real = await importOriginal<typeof import('imapflow')>();
  return { ...real, ImapFlow: class extends real.ImapFlow {
    constructor(options: ConstructorParameters<typeof real.ImapFlow>[0]) {
      transport.productionOptions.push(options as unknown as Record<string, unknown>);
      super({ ...options, host: '127.0.0.1', port: transport.port, secure: false,
        tls: undefined, doSTARTTLS: false, socketTimeout: transport.timeout });
      transport.clients.push(this);
    }
    async getMailboxLock(...args: Parameters<ImapClient['getMailboxLock']>) {
      const lock = await super.getMailboxLock(...args); transport.locks.push(lock); return lock;
    }
  } };
});

const message = Buffer.from([
  'From: Fixture <fixture@example.test>', 'Subject: Synthetic invoice',
  'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
  'Synthetic document processing fixture.', '',
].join('\r\n'));

/** A deliberately small, read-only IMAP fixture. It records command names only. */
async function syntheticImap() {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  let blockFetch = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK local fixture ready\r\n');
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      for (let end; (end = input.indexOf('\r\n')) !== -1;) {
        const line = input.slice(0, end); input = input.slice(end + 2);
        const [, tag, command, args = ''] = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/) || [];
        if (!tag || !command) continue;
        const name = command === 'UID' ? `UID ${args.split(' ')[0]}` : command;
        commands.push(name);
        const ok = () => socket.write(`${tag} OK fixture complete\r\n`);
        switch (name) {
          case 'CAPABILITY': socket.write('* CAPABILITY IMAP4rev1 NAMESPACE\r\n'); ok(); break;
          case 'LOGIN': ok(); break;
          case 'NAMESPACE': socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n'); ok(); break;
          case 'LIST': case 'LSUB': socket.write(`* ${name} () "/" "INBOX"\r\n`); ok(); break;
          case 'EXAMINE': socket.write('* FLAGS (\\Seen)\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY 900]\r\n* OK [UIDNEXT 3]\r\n'); socket.write(`${tag} OK [READ-ONLY] fixture selected\r\n`); break;
          case 'NOOP': ok(); break;
          case 'UID FETCH': {
            if (blockFetch) break;
            const uid = args.split(' ')[1];
            if (/BODY\.PEEK/i.test(args)) {
              socket.write(`* ${uid} FETCH (UID ${uid} INTERNALDATE "04-Oct-2026 12:00:00 +0000" BODY[]<0> {${message.length}}\r\n`);
              socket.write(message); socket.write(')\r\n');
            } else socket.write(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${message.length} INTERNALDATE "04-Oct-2026 12:00:00 +0000")\r\n`);
            ok(); break;
          }
          default: socket.write(`${tag} BAD unsupported fixture command\r\n`);
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture has no port');
  transport.port = address.port;
  return {
    commands,
    blockNextFetch() { blockFetch = true; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function until(condition: () => boolean, description: string, timeout = 2500) {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeout) throw new Error(`Local fixture timeout: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

let fixture: Awaited<ReturnType<typeof syntheticImap>>;
beforeEach(async () => { transport.clients = []; transport.locks = []; transport.productionOptions = []; fixture = await syntheticImap(); });
afterEach(async () => { for (const client of transport.clients) client.close(); await fixture.close(); });

describe('Real ImapFlow lifetime across slow document processing (local synthetic transport)', () => {
  it('reproduces the old mailboxOpen-only session closing during quiet processing', async () => {
    const real = await vi.importActual<typeof import('imapflow')>('imapflow');
    const client = new real.ImapFlow({ host: '127.0.0.1', port: transport.port, secure: false,
      auth: { user: 'fixture@example.test', pass: 'synthetic-only' }, logger: false,
      disableAutoIdle: true, socketTimeout: transport.timeout, doSTARTTLS: false });
    transport.clients.push(client);
    const errors: string[] = [];
    client.on('error', error => errors.push((error as Error & { code: string }).code));
    await client.connect(); await client.mailboxOpen('INBOX', { readOnly: true });
    await until(() => errors.includes('ETIMEOUT'), 'unlocked quiet session expiry');
    await until(() => client.isClosed, 'closed unlocked session');
    expect(fixture.commands.filter(command => command === 'NOOP')).toHaveLength(0);
    const nextRead = await client.fetchOne('2', { size: true }, { uid: true })
      .catch(error => (error as { code: string }).code);
    // ImapFlow may return no row once closed, or reject a pending request during
    // close. Both are mapped to a safe 503 by the connector, never a next message.
    expect([undefined, 'NoConnection']).toContain(nextRead);
    expect(client.usable).toBe(false);
  });

  it('keeps the connector alive while preparation/capture waits, then reads the next mail', async () => {
    const mailbox = await openImapMailbox('fixture@example.test', 'synthetic-only');
    const client = transport.clients[0];
    const failures: string[] = [];
    client.on('error', error => failures.push((error as Error & { code: string }).code));
    const source = await mailbox.read({ uid: '1', date: null });
    expect(source.subject).toBe('Synthetic invoice');
    // Simulate an awaited document preparation/capture step by leaving IMAP quiet
    // until it has survived two real socket-inactivity periods with keepalives.
    await until(() => fixture.commands.filter(command => command === 'NOOP').length >= 2, 'keepalives during slow processing');
    expect(failures).toEqual([]);
    expect((await mailbox.read({ uid: '2', date: null })).subject).toBe(source.subject);
    expect(fixture.commands).toContain('EXAMINE');
    expect(fixture.commands).not.toContain('SELECT');
    expect(transport.productionOptions[0]).toMatchObject({ host: 'mail.infomaniak.com', port: 993, secure: true, socketTimeout: 15000, tls: { rejectUnauthorized: true } });
    const release = vi.spyOn(transport.locks[0], 'release');
    mailbox.close(); mailbox.close();
    expect(release).toHaveBeenCalledOnce();
    expect(client.isClosed).toBe(true); expect(client.usable).toBe(false);
  });

  it('still expires a genuinely blocked command even when the mailbox lock is held', async () => {
    const mailbox = await openImapMailbox('fixture@example.test', 'synthetic-only');
    const client = transport.clients[0];
    expect(transport.locks).toHaveLength(1);
    const release = vi.spyOn(transport.locks[0], 'release');
    const errors: string[] = [];
    client.on('error', error => errors.push((error as Error & { code: string }).code));
    fixture.blockNextFetch();
    await expect(mailbox.read({ uid: '1', date: null })).rejects.toMatchObject({ status: 503 });
    expect(errors).toContain('ETIMEOUT');
    expect(fixture.commands.filter(command => command === 'NOOP')).toHaveLength(0);
    mailbox.close();
    expect(release).toHaveBeenCalledOnce();
  });
});
