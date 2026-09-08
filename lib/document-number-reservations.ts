import { type DeviceSessionContext } from '@/lib/account';
import { AccountPublicError, isInstallationId } from '@/lib/account-security';
import { database } from '@/lib/runtime';

export const MAX_DOCUMENT_NUMBER = 999_999_999;
export const MAX_NUMBER_RESERVATION = 1000;
export type NumberReservationRequest = {
  request_id: string;
  prefix: string;
  year: number;
  minimum: number;
  count: number;
};
type ReservationRow = NumberReservationRequest & {
  organization_id: string;
  installation_id: string;
  start_value: number;
  end_value: number;
  created_at: string;
};

export function numberReservationRequest(
  value: Record<string, unknown>,
): NumberReservationRequest {
  const id =
    typeof value.request_id === 'string' ? value.request_id.toLowerCase() : '';
  const prefix =
    typeof value.prefix === 'string' ? value.prefix.trim().toUpperCase() : '';
  if (!isInstallationId(id))
    throw new AccountPublicError('Référence de réservation invalide.');
  if (!/^[A-Z0-9-]{1,12}$/.test(prefix))
    throw new AccountPublicError('Préfixe de numérotation invalide.');
  const year = value.year as number;
  const minimum = value.minimum as number;
  const count = value.count as number;
  if (
    !Number.isSafeInteger(year) ||
    year < 1900 ||
    year > 9999 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 1 ||
    minimum > MAX_DOCUMENT_NUMBER ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_NUMBER_RESERVATION ||
    minimum + count - 1 > MAX_DOCUMENT_NUMBER
  ) {
    throw new AccountPublicError('Plage de numérotation invalide.');
  }
  return { request_id: id, prefix, year, minimum, count };
}

// This ledger is append-only. Reservations never expire and must never be
// recycled, including after cancellation, device revocation or backup restore.
export async function reserveDocumentNumbers(
  session: DeviceSessionContext,
  input: NumberReservationRequest,
) {
  const db = database();
  await db
    .prepare(`INSERT OR IGNORE INTO document_number_reservations(
    organization_id,request_id,installation_id,created_by,prefix,year,minimum,count,start_value,end_value,created_at
  ) SELECT ?,?,?,?,?,?,?,?,next,next+?-1,? FROM (
    SELECT MAX(COALESCE(MAX(end_value)+1,1),?,COALESCE((SELECT minimum FROM business_sync_number_floors WHERE organization_id=? AND prefix=? AND year=?),1)) AS next FROM document_number_reservations
    WHERE organization_id=? AND prefix=? AND year=?
  ) WHERE next+?-1<=? AND NOT EXISTS(
    SELECT 1 FROM document_number_reservations WHERE organization_id=? AND request_id=?
  ) AND EXISTS(
    SELECT 1 FROM business_sync_spaces WHERE organization_id=? AND state='ready' AND head_revision>0
  )`)
    .bind(
      session.organizationId,
      input.request_id,
      session.installationId,
      session.userId,
      input.prefix,
      input.year,
      input.minimum,
      input.count,
      input.count,
      new Date().toISOString(),
      input.minimum,
      session.organizationId,
      input.prefix,
      input.year,
      session.organizationId,
      input.prefix,
      input.year,
      input.count,
      MAX_DOCUMENT_NUMBER,
      session.organizationId,
      input.request_id,
      session.organizationId,
    )
    .run();
  const row = await db
    .prepare(
      `SELECT reservation.* FROM document_number_reservations reservation
       JOIN business_sync_spaces space ON space.organization_id=reservation.organization_id
       WHERE reservation.organization_id=? AND reservation.request_id=? AND space.state='ready' AND space.head_revision>0`,
    )
    .bind(session.organizationId, input.request_id)
    .first<ReservationRow>();
  if (!row) {
    const ready = await db
      .prepare(
        "SELECT 1 AS ready FROM business_sync_spaces WHERE organization_id=? AND state='ready' AND head_revision>0",
      )
      .bind(session.organizationId)
      .first();
    if (!ready)
      throw new AccountPublicError(
        'L’historique de cette entreprise doit être contrôlé et publié avant de réserver des numéros partagés.',
        409,
      );
    throw new AccountPublicError(
      'La numérotation disponible pour ce préfixe et cette année est épuisée. Choisissez un nouveau préfixe.',
      409,
    );
  }
  if (
    row.installation_id !== session.installationId ||
    row.prefix !== input.prefix ||
    row.year !== input.year ||
    row.minimum !== input.minimum ||
    row.count !== input.count
  ) {
    throw new AccountPublicError(
      'Cette demande a déjà réservé une autre plage de numéros. Reprenez sa demande initiale.',
      409,
    );
  }
  return {
    request_id: row.request_id,
    organization_id: row.organization_id,
    installation_id: row.installation_id,
    prefix: row.prefix,
    year: row.year,
    start_value: row.start_value,
    end_value: row.end_value,
    created_at: row.created_at,
  };
}
