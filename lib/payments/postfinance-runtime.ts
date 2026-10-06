import {
  CheckoutUnavailable,
  type CheckoutConfiguration,
} from './postfinance-client';
import type { WebhookListener } from './postfinance-store';

export type PostFinanceWebhookBinding =
  | 'POSTFINANCE_WEBHOOKS_ENABLED'
  | 'POSTFINANCE_API_ORIGIN'
  | 'POSTFINANCE_APPLICATION_USER_ID'
  | 'POSTFINANCE_AUTHENTICATION_KEY_BASE64'
  | 'POSTFINANCE_SPACE_ID'
  | 'POSTFINANCE_WEBHOOK_LISTENERS_JSON';
export type PostFinanceWebhookConfiguration = {
  connection: CheckoutConfiguration;
  apiOrigin: 'https://checkout.postfinance.ch' | 'https://app-wallee.com';
  spaceId: number;
  listeners: WebhookListener[];
};

function unavailable(): never {
  // Configuration errors must never interpolate a merchant credential or value.
  throw new CheckoutUnavailable(
    'PostFinance webhook configuration is unavailable.',
  );
}
function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function decimalId(value: string) {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !positiveId(Number(value)))
    unavailable();
  return Number(value);
}

/** Read only fixed, server-owned names. Enabling receipt does not enable a
 * purchase or grant any rights; payment routes and settlement are separate. */
export function postFinanceWebhookConfiguration(
  read: (name: PostFinanceWebhookBinding) => string,
): PostFinanceWebhookConfiguration | null {
  if (read('POSTFINANCE_WEBHOOKS_ENABLED') !== 'true') return null;
  const origin =
    read('POSTFINANCE_API_ORIGIN') || 'https://checkout.postfinance.ch';
  if (
    origin !== 'https://checkout.postfinance.ch' &&
    origin !== 'https://app-wallee.com'
  )
    unavailable();
  const userId = read('POSTFINANCE_APPLICATION_USER_ID');
  decimalId(userId);
  const spaceId = decimalId(read('POSTFINANCE_SPACE_ID'));
  const key = read('POSTFINANCE_AUTHENTICATION_KEY_BASE64');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) unavailable();
  try {
    if (atob(key).length !== 32 || btoa(atob(key)) !== key) unavailable();
  } catch {
    unavailable();
  }
  const raw = read('POSTFINANCE_WEBHOOK_LISTENERS_JSON');
  if (!raw || new TextEncoder().encode(raw).length > 8192) unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    unavailable();
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 16)
    unavailable();
  const listeners: WebhookListener[] = parsed.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      unavailable();
    const object = value as Record<string, unknown>;
    if (
      Object.keys(object).some(
        (key) => !['id', 'entityId', 'technicalName'].includes(key),
      ) ||
      !positiveId(object.id) ||
      !positiveId(object.entityId)
    )
      unavailable();
    if (
      object.technicalName !== undefined &&
      (typeof object.technicalName !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_]{0,119}$/.test(object.technicalName))
    )
      unavailable();
    return {
      id: object.id,
      entityId: object.entityId,
      ...(object.technicalName === undefined
        ? {}
        : { technicalName: object.technicalName as string }),
    };
  });
  if (
    new Set(listeners.map((listener) => listener.id)).size !== listeners.length
  )
    unavailable();
  return {
    apiOrigin: origin,
    spaceId,
    listeners,
    connection: {
      enabled: true,
      apiOrigin: origin,
      applicationUserId: userId,
      authenticationKeyBase64: key,
      spaceId,
    },
  };
}
