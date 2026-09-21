import { database } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { workspaceLink, gestionActive } from '@/lib/supplier-inbox/service';
import { automationEntitlement } from '@/lib/automation/service';
import { settingsFor, globalFlags } from '@/lib/automation/config';
import { JevDecisionProvider } from '@/lib/automation/provider';
import { decisionApiKey } from '@/lib/automation/config';
import { reserveAnalysis, finishAnalysis } from '@/lib/support/billing';
import type { AutomationActor } from '@/lib/automation/access';
import type { DeviceSessionContext } from '@/lib/account';
import type { SourceTicket, Workspace } from '@/lib/support/types';
import { extractAppointment, type Appointment } from './extraction';
const now = () => Math.floor(Date.now() / 1000);
type Row = {
  id: string;
  organization_id: string;
  workspace_id: string;
  source_key: string;
  source_hash: string;
  subject: string;
  sender: string;
  extraction: string;
  state: string;
  claimed_installation: string | null;
  claim_token: string | null;
  automatic: number;
  created_at: number;
  updated_at: number;
  imported_at: number | null;
};
export async function appointmentEnabled(actor: AutomationActor) {
  const [active, s, flags] = await Promise.all([
    automationEntitlement(actor),
    settingsFor(actor.organizationId),
    globalFlags(),
  ]);
  return (
    active &&
    s.enabled &&
    s.consent &&
    s.mode === 'suggest' &&
    s.flags.includes('email_classification') &&
    flags.includes('email_classification')
  );
}
export async function captureAppointment(
  workspace: Workspace,
  source: SourceTicket,
) {
  if (!source.mail) return;
  const link = await workspaceLink(workspace.id);
  if (
    !link?.enabled ||
    !(await gestionActive(link.organization_id, link.connected_by))
  )
    return;
  const actor = {
    organizationId: link.organization_id,
    userId: link.connected_by,
    role: 'owner',
    founder: false,
  };
  if (!(await appointmentEnabled(actor))) return;
  const hash = await sha256Hex(
    JSON.stringify([
      source.subject,
      source.body,
      source.mail.calendarText || '',
    ]),
  );
  const already = await database()
    .prepare(
      'SELECT id FROM automation_appointments WHERE organization_id=? AND source_hash=?',
    )
    .bind(link.organization_id, hash)
    .first();
  if (already) return;
  const reservation = await reserveAnalysis(
    workspace,
    'appointment:' + source.externalId,
    crypto.randomUUID(),
  );
  try {
    const key = await decisionApiKey(),
      extraction = await extractAppointment(
        new JevDecisionProvider(key),
        source.subject,
        source.body,
        source.mail.calendarText,
      );
    if (source.incomplete)
      extraction.issues.push(
        'Le message est incomplet. Vérifiez le rendez-vous.',
      );
    const sourceKey = await sha256Hex(
      JSON.stringify([
        source.mail.sender.toLowerCase(),
        extraction.uid ||
          [extraction.title, extraction.startDate, extraction.startTime].join(
            '|',
          ) ||
          source.externalId,
      ]),
    );
    const db = database(),
      previous = await db
        .prepare(
          'SELECT * FROM automation_appointments WHERE organization_id=? AND source_key=?',
        )
        .bind(link.organization_id, sourceKey)
        .first<Row>();
    const state =
      extraction.issues.length || previous?.imported_at ? 'review' : 'ready';
    if (previous) {
      if (previous.claimed_installation)
        throw new AccountPublicError(
          'Un rendez-vous est en cours d’enregistrement. La réception réessaiera.',
          409,
        ); // Retry after the existing import acknowledges; never replace an in-flight claim.
      const updated = await db
        .prepare(
          'UPDATE automation_appointments SET extraction=?,source_hash=?,subject=?,sender=?,state=?,updated_at=? WHERE id=? AND claimed_installation IS NULL',
        )
        .bind(
          JSON.stringify(extraction),
          hash,
          source.subject,
          source.mail.sender,
          state,
          now(),
          previous.id,
        )
        .run();
      if (!updated.meta.changes)
        throw new AccountPublicError(
          'Le rendez-vous est en cours d’enregistrement. La réception réessaiera.',
          409,
        );
    } else {
      const inserted = await db
        .prepare(
          'INSERT INTO automation_appointments(id,organization_id,workspace_id,source_key,source_hash,subject,sender,extraction,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,source_key) DO NOTHING',
        )
        .bind(
          crypto.randomUUID(),
          link.organization_id,
          workspace.id,
          sourceKey,
          hash,
          source.subject,
          source.mail.sender,
          JSON.stringify(extraction),
          state,
          now(),
          now(),
        )
        .run();
      if (!inserted.meta.changes)
        throw new AccountPublicError(
          'Le rendez-vous vient de changer. La réception réessaiera.',
          409,
        );
    }
    await finishAnalysis(reservation, true);
  } catch (error) {
    await finishAnalysis(reservation, false);
    throw error;
  }
}
const publicRow = (r: Row, installation?: string) => ({
  id: r.id,
  organizationId: r.organization_id,
  subject: r.subject,
  sender: r.sender,
  extraction: JSON.parse(r.extraction) as Appointment,
  state: r.state,
  automatic: r.automatic === 1,
  otherDevice:
    !!r.claimed_installation && r.claimed_installation !== installation,
  importedAt: r.imported_at,
  updatedAt: r.updated_at,
});
export async function appointmentState(
  actor: AutomationActor,
  installation?: string,
) {
  const active = await automationEntitlement(actor);
  if (!active)
    return {
      organizationId: actor.organizationId,
      active: false,
      automatic: false,
      items: [],
    };
  const rows = await database()
    .prepare(
      "SELECT * FROM automation_appointments WHERE organization_id=? ORDER BY CASE WHEN state IN ('imported','ignored') THEN 1 ELSE 0 END,updated_at DESC LIMIT 100",
    )
    .bind(actor.organizationId)
    .all<Row>();
  return {
    organizationId: actor.organizationId,
    active: true,
    automatic: await appointmentEnabled(actor),
    items: rows.results.map((r) => publicRow(r, installation)),
  };
}
async function item(org: string, id: unknown) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    throw new AccountPublicError('Choisissez un rendez-vous.');
  const row = await database()
    .prepare(
      'SELECT * FROM automation_appointments WHERE organization_id=? AND id=?',
    )
    .bind(org, id)
    .first<Row>();
  if (!row) throw new AccountPublicError('Rendez-vous inaccessible.', 404);
  return row;
}
export async function appointmentAction(
  session: DeviceSessionContext,
  raw: Record<string, unknown>,
) {
  if (session.role === 'read_only')
    throw new AccountPublicError(
      'Votre rôle permet la consultation uniquement.',
      403,
    );
  const actor = { ...session, founder: false, device: true };
  if (!(await automationEntitlement(actor)))
    throw new AccountPublicError(
      'Activez Automation pour cette entreprise.',
      402,
    );
  let row = await item(session.organizationId, raw.id);
  const db = database();
  if (raw.action === 'ignore') {
    if (row.claimed_installation)
      throw new AccountPublicError('Enregistrement en cours.', 409);
    await db
      .prepare(
        "UPDATE automation_appointments SET state='ignored',updated_at=? WHERE id=? AND organization_id=? AND claimed_installation IS NULL",
      )
      .bind(now(), row.id, session.organizationId)
      .run();
    return { saved: true };
  }
  if (raw.action === 'claim') {
    if (row.state === 'imported')
      return {
        alreadyImported: true,
        item: publicRow(row, session.installationId),
      };
    if (row.state === 'ignored')
      throw new AccountPublicError('Ce rendez-vous a été écarté.', 409);
    const e = JSON.parse(row.extraction) as Appointment;
    if (raw.automatic === true) {
      const link = await workspaceLink(row.workspace_id);
      if (!link?.enabled || link.organization_id !== session.organizationId)
        throw new AccountPublicError(
          'La réception automatique est en pause. Vérifiez la connexion Support.',
          409,
        );
    }
    if (
      raw.automatic === true &&
      (row.imported_at ||
        e.issues.length ||
        e.status !== 'scheduled' ||
        e.confidence <
          Math.max(
            0.95,
            (await settingsFor(actor.organizationId)).thresholds.high,
          ) ||
        !(await appointmentEnabled(actor)))
    )
      throw new AccountPublicError(
        'Ce rendez-vous demande votre vérification.',
        409,
      );
    await db
      .prepare(
        "UPDATE automation_appointments SET claimed_installation=?,claim_token=?,state='processing' WHERE id=? AND organization_id=? AND claimed_installation IS NULL AND state IN ('ready','review')",
      )
      .bind(
        session.installationId,
        crypto.randomUUID(),
        row.id,
        session.organizationId,
      )
      .run();
    row = await item(session.organizationId, row.id);
    if (row.claimed_installation !== session.installationId)
      throw new AccountPublicError(
        'Enregistrement en cours sur un autre appareil.',
        409,
      );
    return {
      item: publicRow(row, session.installationId),
      claimToken: row.claim_token,
    };
  }
  if (
    row.claimed_installation !== session.installationId ||
    row.claim_token !== raw.claimToken
  )
    throw new AccountPublicError('La réception a changé. Actualisez-la.', 409);
  if (raw.action === 'finish') {
    await db
      .prepare(
        "UPDATE automation_appointments SET state='imported',automatic=?,imported_at=?,updated_at=?,claimed_installation=NULL,claim_token=NULL WHERE id=? AND organization_id=? AND claim_token=?",
      )
      .bind(
        Number(raw.automatic === true),
        now(),
        now(),
        row.id,
        session.organizationId,
        row.claim_token,
      )
      .run();
    return { saved: true };
  }
  if (raw.action === 'release') {
    const e = JSON.parse(row.extraction) as Appointment;
    e.issues = [
      ...new Set([
        ...e.issues,
        typeof raw.reason === 'string'
          ? raw.reason.slice(0, 250)
          : 'Vérifiez ce rendez-vous.',
      ]),
    ];
    await db
      .prepare(
        "UPDATE automation_appointments SET state='review',extraction=?,claimed_installation=NULL,claim_token=NULL WHERE id=? AND organization_id=? AND claim_token=?",
      )
      .bind(JSON.stringify(e), row.id, session.organizationId, row.claim_token)
      .run();
    return { saved: true };
  }
  throw new AccountPublicError('Action inconnue.');
}
export async function appointmentDaily(
  org: string,
  from: number,
  until: number,
) {
  const r = await database()
    .prepare(
      "SELECT SUM(state='imported' AND imported_at>=? AND imported_at<?) AS imported,SUM(state IN ('ready','review','processing')) AS pending FROM automation_appointments WHERE organization_id=?",
    )
    .bind(from, until, org)
    .first<{ imported: number; pending: number }>();
  return {
    imported: Number(r?.imported || 0),
    pending: Number(r?.pending || 0),
  };
}
