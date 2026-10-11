/** A8 test-only composition. Real cumulative D1 migrations, SQLite transactions,
 * published/historical fences and ledgers; authority/source/catalogue facts are
 * deliberately synthetic QA predicates, not production permission evidence.
 * Importing tests must supply their runtime/authentication perimeter mocks. */
import { type DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  confirmationSqliteAdapter,
  makeQuoteConfirmationFixture,
} from './confirmation-records.fixture';
import { createD1QuoteLedger } from './ledger';
import { createHistoricalQuoteFences } from './historical-quote-fences';
import { createPublishedQuoteFences } from './published-fences';
import { createD1QuotePublicationEvidence } from './quote-publication-evidence';
import type {
  DeviceQuoteAuthority,
  DeviceQuoteAdmissionCas,
} from './production-admission';
import type { PublishedQuotePublication } from './published-context';
import type {
  SupportQuoteSourceCapability,
  SupportQuoteAccessCapability,
} from './support-source';
import { combineQuotePredicates } from './support-source';
import type { QuoteLedgerPredicate } from './ledger-types';
import {
  ActionEngineError,
  type ActionActor,
  type ActionAdmission,
} from './types';
import {
  actionIdentifier,
  captureActor,
  validatePlanAgainstContext,
  validatePlanningContext,
} from './validation';

type SqliteStatement = {
  sql: string;
  values: SQLInputValue[];
  first: <T = Record<string, unknown>>(column?: string) => Promise<T | null>;
};
function withFirst(
  sql: DatabaseSync,
  adapter: ReturnType<typeof confirmationSqliteAdapter>,
) {
  return {
    prepare(query: string) {
      const statement = adapter.db.prepare(query) as unknown as SqliteStatement;
      statement.first = async <T>(column?: string) => {
        const row = sql.prepare(statement.sql).get(...statement.values);
        return (
          row ? (column === undefined ? row : row[column]) : null
        ) as T | null;
      };
      return statement;
    },
    batch: adapter.db.batch.bind(adapter.db),
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}

export function makeDeviceReservationFixture() {
  const base = makeQuoteConfirmationFixture(),
    { native, sql, actor } = base;
  const secondActor = captureActor({
    ...actor,
    userId: 'synthetic-second-user',
  });
  const installationIds = Object.freeze([
    native.reservation.installationId,
    '00000000-0000-4000-8000-000000008002',
  ] as const);
  const actors = Object.freeze([actor, secondActor] as const);
  sql.exec(`CREATE TABLE qa_reservation_authority(
    organization_id TEXT NOT NULL,user_id TEXT NOT NULL,installation_id TEXT NOT NULL,
    allowed INTEGER NOT NULL,write_enabled INTEGER NOT NULL,revision INTEGER NOT NULL,
    PRIMARY KEY(organization_id,user_id,installation_id));
    CREATE TABLE qa_reservation_source(
    organization_id TEXT NOT NULL,source_id TEXT NOT NULL,allowed INTEGER NOT NULL,
    source_revision TEXT NOT NULL,catalogue_revision TEXT NOT NULL,
    PRIMARY KEY(organization_id,source_id));`);
  for (const identity of actors)
    for (const installationId of installationIds)
      sql
        .prepare('INSERT INTO qa_reservation_authority VALUES(?,?,?,1,1,1)')
        .run(identity.organizationId, identity.userId, installationId);

  // A6's archive fixture intentionally does not model a planner/context loader.
  // Keep it unchanged for historical proof. The NEW reservation branch uses
  // the same canonical plan with a matching subject and one literal per line.
  // These are synthetic admitted source facts, never recovered from a hash.
  const plan = native.proposal.plan,
    proposal = native.proposal;
  const context = validatePlanningContext({
    organizationId: actor.organizationId,
    revision: plan.contextRevision,
    currency: plan.currency,
    source: {
      ...native.source,
      subject: plan.title,
      body: plan.lines.map((line) => line.evidence).join('\n'),
    },
    customers: [],
    articles: plan.lines.map((line) => ({
      id: line.articleId,
      revision: line.articleRevision,
      organizationId: actor.organizationId,
      name: line.description,
      description: line.description,
      sku: '',
      unit: line.unit,
      currency: plan.currency,
      unitPriceCents: line.unitPriceCents,
      taxRateBp: line.taxRateBp,
      archived: false,
    })),
  });
  // Fail early if a fixture edit ceases to satisfy the actual core validator.
  validatePlanAgainstContext(plan, context);
  sql
    .prepare('INSERT INTO qa_reservation_source VALUES(?,?,1,?,?)')
    .run(
      actor.organizationId,
      context.source.id,
      context.source.revision,
      context.revision,
    );
  const h = native.binding.planningPublication;
  const publication: PublishedQuotePublication = Object.freeze({
    ...h,
    firstChunkSha256: '1'.repeat(64),
    sidecarSha256: '2'.repeat(64),
    resourcesHash: native.binding.resourcesSha256,
  });
  const adapter = base.adapter,
    db = withFirst(sql, adapter);
  function authority(
    rawActor: ActionActor = actor,
    rawInstallationId: string = installationIds[0],
  ): DeviceQuoteAuthority {
    const identity = captureActor(rawActor),
      installationId = actionIdentifier(rawInstallationId);
    const values = [identity.organizationId, identity.userId, installationId];
    const predicate: DeviceQuoteAuthority['predicate'] = (purpose) =>
      Object.freeze({
        // Deliberately match production-admission's division of responsibility:
        // country is absent here so the real wrapper/historical SQL must fence it.
        sql: `EXISTS(SELECT 1 FROM qa_reservation_authority WHERE organization_id=? AND user_id=? AND installation_id=? AND allowed=1${purpose === 'progression' ? ' AND write_enabled=1' : ''})`,
        bindings: Object.freeze([...values]),
      });
    const allowed = (gate: QuoteLedgerPredicate) =>
      sql
        .prepare(`SELECT CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END admitted`)
        .get(...gate.bindings)?.admitted === 1;
    function currentAdmission(): ActionAdmission {
      if (!allowed(predicate('progression')))
        throw new ActionEngineError('forbidden');
      const revision = sql
        .prepare(
          'SELECT revision FROM qa_reservation_authority WHERE organization_id=? AND user_id=? AND installation_id=?',
        )
        .get(...values)?.revision;
      if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new ActionEngineError('invalid_context');
      return Object.freeze({
        ...identity,
        revision: `qa-authority-v${revision}`,
        automationActive: true,
        mayPrepareQuote: true,
      });
    }
    async function preflightCas(): Promise<DeviceQuoteAdmissionCas> {
      const admission = currentAdmission();
      const revision = Number(
        admission.revision.slice('qa-authority-v'.length),
      );
      return Object.freeze({
        admission,
        predicate: () =>
          combineQuotePredicates(predicate('progression'), {
            sql: 'EXISTS(SELECT 1 FROM qa_reservation_authority WHERE organization_id=? AND user_id=? AND installation_id=? AND revision=?)',
            bindings: [...values, revision],
          }),
      });
    }
    return Object.freeze({
      actor: identity,
      installationId,
      predicate,
      preflight: async () => currentAdmission(),
      preflightCas,
      authorizeRead: async () => {
        if (!allowed(predicate('read')))
          throw new ActionEngineError('forbidden');
      },
    });
  }
  const sourceCapability: SupportQuoteSourceCapability = Object.freeze({
    source: context.source,
    revision: context.source.revision,
    workspaceId: 'qa-reservation-support',
    predicate: (purpose) => ({
      sql: `EXISTS(SELECT 1 FROM qa_reservation_source WHERE organization_id=? AND source_id=? AND allowed=1${purpose === 'progression' ? ' AND source_revision=? AND catalogue_revision=?' : ''})`,
      bindings:
        purpose === 'progression'
          ? [
              actor.organizationId,
              context.source.id,
              context.source.revision,
              context.revision,
            ]
          : [actor.organizationId, context.source.id],
    }),
  });
  const access: SupportQuoteAccessCapability = Object.freeze({
    sourceId: context.source.id,
    workspaceId: sourceCapability.workspaceId,
    predicate: () => sourceCapability.predicate('read'),
  });
  const admission: ActionAdmission = Object.freeze({
    ...actor,
    revision: 'qa-authority-v1',
    automationActive: true,
    mayPrepareQuote: true,
  });
  async function loaded(
    identity: ActionActor = actor,
    installationId: string = installationIds[0],
  ) {
    const current = sql
      .prepare(
        'SELECT allowed,source_revision,catalogue_revision FROM qa_reservation_source WHERE organization_id=? AND source_id=?',
      )
      .get(actor.organizationId, context.source.id);
    if (current?.allowed !== 1) throw new ActionEngineError('forbidden');
    // A hash-only historical binding cannot recreate changed source facts.
    // This fixture refuses them rather than inventing a replacement context.
    if (
      current.source_revision !== context.source.revision ||
      current.catalogue_revision !== context.revision
    )
      throw new ActionEngineError('stale_plan');
    return Object.freeze({
      context,
      publication,
      sourceCapability,
      workspaceId: sourceCapability.workspaceId,
      admission: await authority(identity, installationId).preflight(),
    });
  }
  function seedPlanningPublication() {
    if (
      sql
        .prepare(
          'SELECT id FROM action_engine_publication_attempts WHERE organization_id=? AND snapshot_id=?',
        )
        .get(h.organizationId, h.snapshotId)
    )
      return;
    base.seedPublication({
      id: base.nextId(),
      organizationId: h.organizationId,
      snapshotId: h.snapshotId,
      installationId: installationIds[0],
      userId: actor.userId,
      baseRevision: h.baseRevision,
      archiveSha256: h.archiveSha256,
      manifestSha256: h.manifestSha256,
      sizeBytes: 1000,
      state: 'committed',
      result: {
        committed: true,
        revision: h.revision,
        snapshotId: h.snapshotId,
      },
      createdAt: native.reservation.createdAt - 10,
      settledAt: native.reservation.createdAt - 5,
    });
  }
  function seedProposal() {
    seedPlanningPublication();
    sql.exec('BEGIN IMMEDIATE');
    try {
      sql
        .prepare(
          'INSERT INTO action_engine_quote_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          proposal.id,
          proposal.organizationId,
          plan.sourceId,
          plan.kind,
          proposal.fingerprint,
          plan.sourceRevision,
          plan.contextRevision,
          JSON.stringify(plan),
          actor.userId,
          native.reservation.createdAt - 1,
        );
      sql
        .prepare('INSERT INTO action_engine_quote_events VALUES(?,?,?,?,?,?,?)')
        .run(
          base.nextId(),
          actor.organizationId,
          proposal.id,
          proposal.fingerprint,
          'proposal_saved',
          actor.userId,
          native.reservation.createdAt - 1,
        );
      sql.exec('COMMIT');
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
    return proposal;
  }
  async function published(
    identity: ActionActor = actor,
    installationId: string = installationIds[0],
  ) {
    const capability = authority(identity, installationId),
      cas = await capability.preflightCas(),
      snapshot = await loaded(identity, installationId),
      fences = await createPublishedQuoteFences(capability, cas, snapshot);
    return Object.freeze({
      authority: capability,
      cas,
      loaded: snapshot,
      fences,
      ledger: createD1QuoteLedger(db, fences.ledgerFence, {
        nowSeconds: () => native.reservation.createdAt,
        newUuid: base.nextId,
        reservationBinding: fences.reservationBinding,
      }),
    });
  }
  function historical(
    identity: ActionActor = actor,
    installationId: string = installationIds[0],
  ) {
    return createHistoricalQuoteFences(
      authority(identity, installationId),
      access,
    );
  }
  async function seedConfirmedEvidence(confirm = true) {
    // Separate historical branch: this intentionally uses A6's ORIGINAL source
    // hash/plan/archive, never pretends that its source is the current context.
    base.seed();
    base.seedPublication(native.publication);
    const fences = historical(),
      options = {
        nowSeconds: () => native.reservation.createdAt + 20,
        newUuid: base.nextId,
      },
      journal = createD1QuotePublicationEvidence(
        db,
        fences.evidenceFence,
        options,
      ),
      verified = await native.verify(),
      evidence = await journal.append(actor, verified);
    if (confirm)
      await createD1QuoteLedger(
        db,
        fences.ledgerFence,
        options,
      ).confirmExecution(
        actor,
        proposal.id,
        installationIds[0],
        native.reservation.id,
        native.receipt,
      );
    return Object.freeze({
      verified,
      evidence,
      receipt: native.receipt,
      proposal: native.proposal,
      reservation: Object.freeze({
        ...native.reservation,
        receipt: confirm ? native.receipt : null,
      }),
      binding: native.binding,
    });
  }
  const gates = {
    authorityAllowed(
      allowed: boolean,
      identity: ActionActor = actor,
      installationId: string = installationIds[0],
    ) {
      sql
        .prepare(
          'UPDATE qa_reservation_authority SET allowed=? WHERE organization_id=? AND user_id=? AND installation_id=?',
        )
        .run(
          Number(allowed),
          identity.organizationId,
          identity.userId,
          installationId,
        );
    },
    writeEnabled(
      enabled: boolean,
      identity: ActionActor = actor,
      installationId: string = installationIds[0],
    ) {
      sql
        .prepare(
          'UPDATE qa_reservation_authority SET write_enabled=? WHERE organization_id=? AND user_id=? AND installation_id=?',
        )
        .run(
          Number(enabled),
          identity.organizationId,
          identity.userId,
          installationId,
        );
    },
    authorityRevision(
      revision: number,
      identity: ActionActor = actor,
      installationId: string = installationIds[0],
    ) {
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw Error('Invalid QA revision');
      sql
        .prepare(
          'UPDATE qa_reservation_authority SET revision=? WHERE organization_id=? AND user_id=? AND installation_id=?',
        )
        .run(
          revision,
          identity.organizationId,
          identity.userId,
          installationId,
        );
    },
    sourceAllowed(allowed: boolean) {
      sql
        .prepare('UPDATE qa_reservation_source SET allowed=?')
        .run(Number(allowed));
    },
    sourceRevision(revision: string) {
      sql
        .prepare('UPDATE qa_reservation_source SET source_revision=?')
        .run(actionIdentifier(revision));
    },
    catalogueRevision(revision: string) {
      sql
        .prepare('UPDATE qa_reservation_source SET catalogue_revision=?')
        .run(actionIdentifier(revision));
    },
    countryUs: base.seedUsIntent,
  };
  return {
    base,
    native,
    sql,
    db,
    actor,
    actors,
    installationIds,
    plan,
    proposal,
    admission,
    currentAdmission: (
      identity: ActionActor = actor,
      installationId: string = installationIds[0],
    ) => authority(identity, installationId).preflight(),
    context,
    publication,
    sourceCapability,
    access,
    authority,
    loaded,
    published,
    historical,
    seedProposal,
    seedPlanningPublication,
    seedConfirmedEvidence,
    gates,
    adapter,
    seedPublication: base.seedPublication,
    connect: base.connect,
    nextId: base.nextId,
    databaseFor(connection: DatabaseSync) {
      const port = confirmationSqliteAdapter(connection);
      return { db: withFirst(connection, port), adapter: port };
    },
    close: base.close.bind(base),
  };
}
