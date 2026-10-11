import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Unexpected production runtime in private SQLite QA');
  },
}));
import { makeQuoteConfirmationFixture } from './confirmation-records.fixture';
import {
  readBoundQuoteExecution,
  type QuoteConfirmationReadFence,
} from './confirmation-records';
import { createD1QuoteLedger } from './ledger';
import { createD1QuotePublicationEvidence } from './quote-publication-evidence';
import type { QuoteLedgerPredicate } from './ledger-types';

const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
let f: ReturnType<typeof makeQuoteConfirmationFixture> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
function setup() {
  f = makeQuoteConfirmationFixture();
  f.seed();
  const q = f,
    fences = q.historical();
  const options = {
    nowSeconds: () => q.native.reservation.createdAt + 20,
    newUuid: q.nextId,
  };
  const ledger = createD1QuoteLedger(q.db, fences.ledgerFence, options);
  const evidence = createD1QuotePublicationEvidence(
    q.db,
    fences.evidenceFence,
    options,
  );
  const recordsFence: QuoteConfirmationReadFence = (identity) =>
    fences.ledgerFence({
      operation: 'read',
      actor: identity.actor,
      sourceId: null,
      proposalId: identity.proposalId,
    });
  function evaluate(p: QuoteLedgerPredicate) {
    return q.sql
      .prepare(`SELECT CASE WHEN (${p.sql}) THEN 1 ELSE 0 END allowed`)
      .get(...p.bindings)?.allowed;
  }
  return { ...q, fences, ledger, evidence, recordsFence, evaluate };
}
suite(
  'historical confirmation fences, real D1 country and evidence predicates',
  () => {
    it('requires exact A6 evidence and current delegated authority, then confirms a historical receipt', async () => {
      const q = setup();
      q.seedPublication(q.native.publication);
      await expect(
        q.ledger.confirmExecution(
          q.actor,
          q.identity.proposalId,
          q.identity.installationId,
          q.identity.reservationId,
          q.native.receipt,
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await q.evidence.append(q.actor, await q.native.verify());
      expect(
        await q.ledger.confirmExecution(
          q.actor,
          q.identity.proposalId,
          q.identity.installationId,
          q.identity.reservationId,
          q.native.receipt,
        ),
      ).toEqual(q.native.receipt);
    });
    it('historical proof survives a later committed and a pending publication, without catalogue/source-current predicates', async () => {
      const q = setup();
      q.seedPublication(q.native.publication);
      await q.evidence.append(q.actor, await q.native.verify());
      const next = q.nextId();
      q.seedPublication({
        ...q.native.publication,
        id: q.nextId(),
        snapshotId: next,
        baseRevision: 5,
        result: { committed: true, revision: 6, snapshotId: next },
      });
      q.seedPublication({
        ...q.native.publication,
        id: q.nextId(),
        snapshotId: q.nextId(),
        baseRevision: 6,
        state: 'pending',
        result: null,
        settledAt: null,
      });
      expect(
        await q.ledger.confirmExecution(
          q.actor,
          q.identity.proposalId,
          q.identity.installationId,
          q.identity.reservationId,
          q.native.receipt,
        ),
      ).toEqual(q.native.receipt);
      expect(
        (await readBoundQuoteExecution(q.db, q.recordsFence, q.identity))
          .reservation.receipt,
      ).toEqual(q.native.receipt);
    });
    it.each(['authority', 'support'] as const)(
      'revoking current %s in another connection closes read/evidence/confirmation atomically',
      async (kind) => {
        const q = setup();
        q.seedPublication(q.native.publication);
        await q.evidence.append(q.actor, await q.native.verify());
        const other = q.connect();
        other.exec(`UPDATE qa_confirmation_${kind} SET allowed=0`);
        await expect(
          q.ledger.loadProposal(q.actor, q.identity.proposalId),
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          q.evidence.read(q.actor, q.identity.reservationId),
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          q.ledger.confirmExecution(
            q.actor,
            q.identity.proposalId,
            q.identity.installationId,
            q.identity.reservationId,
            q.native.receipt,
          ),
        ).rejects.toMatchObject({ code: 'forbidden' });
        expect(
          q.sql
            .prepare(
              'SELECT receipt_json FROM action_engine_quote_reservations',
            )
            .get()?.receipt_json,
        ).toBeNull();
        expect(
          q.sql
            .prepare('SELECT count(*) n FROM action_engine_atomic_assertions')
            .get()?.n,
        ).toBe(0);
      },
    );
    it('an actual US intention blocks all historical reads, evidence append and confirmation', async () => {
      const q = setup();
      q.seedPublication(q.native.publication);
      const verified = await q.native.verify();
      await q.evidence.append(q.actor, verified);
      q.seedUsIntent();
      await expect(
        readBoundQuoteExecution(q.db, q.recordsFence, q.identity),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        q.ledger.findProposal(q.actor, q.identity.sourceId),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        q.ledger.loadProposal(q.actor, q.identity.proposalId),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        q.evidence.read(q.actor, q.identity.reservationId),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(q.evidence.append(q.actor, verified)).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(
        q.ledger.confirmExecution(
          q.actor,
          q.identity.proposalId,
          q.identity.installationId,
          q.identity.reservationId,
          q.native.receipt,
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
    it('country intention arriving after fence construction and before the actual batch prevents disclosure', async () => {
      const q = setup();
      q.adapter.beforeNext(() => q.seedUsIntent());
      await expect(
        readBoundQuoteExecution(q.db, q.recordsFence, q.identity),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(
        q.sql
          .prepare('SELECT count(*) n FROM action_engine_atomic_assertions')
          .get()?.n,
      ).toBe(0);
    });
    it('an unrelated tenant US intention does not close the admitted CH tenant', async () => {
      const q = setup();
      q.seedUsIntent('other-company');
      expect(
        (await readBoundQuoteExecution(q.db, q.recordsFence, q.identity))
          .proposal,
      ).toEqual(q.native.proposal);
    });
    it('historical fences refuse save and reserve even with genuine ready facts', async () => {
      const q = setup();
      const save = await q.fences.ledgerFence({
        operation: 'save',
        actor: q.actor,
        proposal: q.native.proposal,
        admission: {
          ...q.actor,
          revision: 'qa',
          automationActive: true,
          mayPrepareQuote: true,
        },
      });
      const reserve = await q.fences.ledgerFence({
        operation: 'reserve',
        actor: q.actor,
        proposal: q.native.proposal,
        installationId: q.identity.installationId,
      });
      expect(q.evaluate(save)).toBe(0);
      expect(q.evaluate(reserve)).toBe(0);
    });
    it('correlates current actor, installation and delegated source before any proof can admit confirmation', async () => {
      const q = setup();
      for (const patch of [
        { actor: { ...q.actor, userId: 'other-user' } },
        {
          reservation: { ...q.native.reservation, installationId: q.nextId() },
        },
        {
          proposal: {
            ...q.native.proposal,
            plan: { ...q.native.proposal.plan, sourceId: 'other-source' },
          },
        },
      ]) {
        await expect(
          q.fences.ledgerFence({
            operation: 'confirm',
            actor: q.actor,
            proposal: q.native.proposal,
            reservation: q.native.reservation,
            receipt: q.native.receipt,
            ...patch,
          }),
        ).rejects.toMatchObject({ code: 'forbidden' });
      }
    });
  },
);
