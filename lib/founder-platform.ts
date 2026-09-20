import { database, runtimeValue } from './runtime';
import { AccountPublicError, sha256Hex } from './account-security';
import { isUuid } from './founder-access-policy';
import { encryptSecret } from './support/crypto';
import { verifyPlatformApiKey } from './support/jev';
import { decisionApiKey } from './automation/config';
import { JevDecisionProvider } from './automation/provider';
import { buildPolicy } from './automation/policies';

export const PLATFORM_PATH = '/api/founder/platform';
export const PLATFORM_DOMAIN = 'zentra-founder-platform-v1\n';
type Action = {
  operation: 'state' | 'test' | 'save_key';
  apiKey?: string;
  operationId?: string;
  expectedRevision?: string;
};
type Saved = { secret: string; updated_at: number };
const stored = () =>
  database()
    .prepare(
      "SELECT secret,updated_at FROM support_platform_secrets WHERE id='typesafe'",
    )
    .first<Saved>();
const revision = (row: Saved | null) =>
  row ? sha256Hex(row.secret) : Promise.resolve('initial');
export function parsePlatformAction(value: unknown): Action {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountPublicError('Commande invalide.');
  const a = value as Record<string, unknown>;
  if (
    Object.keys(a).some(
      (k) =>
        !['operation', 'apiKey', 'operationId', 'expectedRevision'].includes(k),
    ) ||
    !['state', 'test', 'save_key'].includes(String(a.operation))
  )
    throw new AccountPublicError('Commande inconnue.');
  if (a.operation !== 'save_key') {
    if (Object.keys(a).length !== 1)
      throw new AccountPublicError('Champ inattendu.');
    return { operation: a.operation as 'state' | 'test' };
  }
  if (
    typeof a.apiKey !== 'string' ||
    !a.apiKey.trim() ||
    a.apiKey.length > 8192 ||
    a.apiKey
      .trim()
      .split('')
      .some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) ||
    !isUuid(a.operationId) ||
    typeof a.expectedRevision !== 'string' ||
    !/^(initial|[a-f0-9]{64})$/.test(a.expectedRevision)
  )
    throw new AccountPublicError(
      'Vérifiez la clé et actualisez son état avant de l’enregistrer.',
    );
  return {
    operation: 'save_key',
    apiKey: a.apiKey.trim(),
    operationId: a.operationId,
    expectedRevision: a.expectedRevision,
  };
}
export async function platformState() {
  const row = await stored();
  return {
    configured: !!row || !!runtimeValue('TYPESAFE_API_KEY'),
    updatedAt: row ? new Date(row.updated_at * 1000).toISOString() : null,
    revision: await revision(row),
    provider: 'Jev',
    products: ['Automation', 'Support'],
  };
}
export async function platformCommand(action: Action) {
  if (action.operation === 'state') return platformState();
  if (action.operation === 'test') {
    const key = await decisionApiKey();
    await verifyPlatformApiKey(key);
    const policy = buildPolicy(
      'transaction_classification',
      {
        text: 'Achat de vis et outils pour un projet.',
        amountCents: 18500,
        currency: 'CHF',
        direction: 'outgoing',
      },
      { suppliers: [], projects: [], expenseCategories: [] },
      'owner',
    );
    const tested = await new JevDecisionProvider(key).decide(policy.input);
    return {
      ...(await platformState()),
      verified: true,
      supportVerified: true,
      automationVerified: true,
      latencyMs: tested.latencyMs,
    };
  }
  const hash = await sha256Hex(JSON.stringify(action)),
    db = database();
  const previous = await db
    .prepare(
      'SELECT action_hash,result_json FROM founder_platform_operations WHERE operation_id=?',
    )
    .bind(action.operationId)
    .first<{ action_hash: string; result_json: string }>();
  if (previous) {
    if (previous.action_hash !== hash)
      throw new AccountPublicError(
        'Cette référence a déjà servi à une autre modification.',
        409,
      );
    return { ...JSON.parse(previous.result_json), replayed: true };
  }
  const old = await stored();
  if ((await revision(old)) !== action.expectedRevision)
    throw new AccountPublicError(
      'La clé a changé. Actualisez son état avant de confirmer.',
      409,
    );
  const key = await verifyPlatformApiKey(action.apiKey);
  // Validate the same replacement with both consumers before touching the working key.
  const policy = buildPolicy(
    'transaction_classification',
    { text: 'Achat de matériel pour un projet.' },
    { suppliers: [], projects: [], expenseCategories: [] },
    'owner',
  );
  await new JevDecisionProvider(key).decide(policy.input);
  const secret = await encryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      key,
      'platform:typesafe',
    ),
    time = Math.floor(Date.now() / 1000);
  const result = {
    configured: true,
    updatedAt: new Date(time * 1000).toISOString(),
    revision: await sha256Hex(secret),
    provider: 'Jev',
    products: ['Automation', 'Support'],
    verified: true,
  };
  const writes = await db.batch([
    old
      ? db
          .prepare(
            "UPDATE support_platform_secrets SET secret=?,updated_by='founder-pc',updated_at=? WHERE id='typesafe' AND secret=?",
          )
          .bind(secret, time, old.secret)
      : db
          .prepare(
            "INSERT INTO support_platform_secrets(id,secret,updated_by,updated_at) VALUES('typesafe',?,'founder-pc',?) ON CONFLICT(id) DO NOTHING",
          )
          .bind(secret, time),
    db
      .prepare(
        "INSERT INTO founder_platform_operations(operation_id,action_hash,result_json,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM support_platform_secrets WHERE id='typesafe' AND secret=?)",
      )
      .bind(action.operationId, hash, JSON.stringify(result), time, secret),
  ]);
  if (writes[0].meta.changes !== 1)
    throw new AccountPublicError(
      'La clé a changé. Actualisez son état avant de confirmer.',
      409,
    );
  return { ...result, replayed: false };
}
