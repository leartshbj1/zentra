'use client';
import { useEffect, useState } from 'react';
import type { SwissMethod } from '@/lib/payments/postfinance-client';
import { postFinancePurchasePath } from '@/lib/payments/postfinance-client-navigation';
import './swiss-payment-methods.css';

export function SwissPaymentMethods({
  product,
  organizationId,
  workspaceId,
  disabled = false,
}: {
  product: string;
  organizationId?: string;
  workspaceId?: string;
  disabled?: boolean;
}) {
  const [option, setOption] = useState<{
    product: string;
    available: boolean;
    testMode: boolean;
    methods: readonly SwissMethod[];
  } | null>(null);
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController(),
      timeout = window.setTimeout(() => controller.abort(), 10000);
    fetch(
      '/api/payments/postfinance/option?product=' + encodeURIComponent(product),
      {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      },
    )
      .then(async (res) => ({
        ok: res.ok,
        data: (await res.json()) as {
          available?: boolean;
          testMode?: boolean;
          methods?: unknown;
          purchaseContext?: unknown;
        },
      }))
      .then(({ ok, data }) => {
        const methods =
          Array.isArray(data.methods) &&
          data.methods.length > 0 &&
          data.methods.length <= 2 &&
          data.methods.every(
            (method) => method === 'postfinance_pay' || method === 'twint',
          ) &&
          new Set(data.methods).size === data.methods.length
            ? (data.methods as SwissMethod[])
            : [];
        if (!controller.signal.aborted)
          setOption({
            product,
            available:
              ok &&
              data.available === true &&
              typeof data.testMode === 'boolean' &&
              typeof data.purchaseContext === 'string' &&
              /^[A-Za-z0-9_-]{43}$/.test(data.purchaseContext) &&
              methods.length > 0,
            testMode: data.testMode === true,
            methods,
          });
      })
      .catch(() => {
        /* The ordinary card/TWINT path remains intact. */
      });
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [product, disabled]);
  const available =
    !disabled && option?.product === product && option.available;
  return (
    <div className="swiss-payment-methods" aria-label="Moyens de paiement">
      <span>Carte ou TWINT</span>
      {available ? (
        <a href={postFinancePurchasePath(product, organizationId, workspaceId)}>
          {option?.methods
            .map((method) => (method === 'twint' ? 'TWINT' : 'PostFinance Pay'))
            .join(' · ')}{' '}
          {option?.testMode && <small>Essai privé</small>}
        </a>
      ) : (
        <span className="swiss-payment-unavailable">
          PostFinance Pay <small>Pas encore disponible</small>
        </span>
      )}
    </div>
  );
}
