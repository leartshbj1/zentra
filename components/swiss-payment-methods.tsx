'use client';
import { useEffect, useState } from 'react';
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
        data: (await res.json()) as { available?: boolean; testMode?: boolean },
      }))
      .then(({ ok, data }) => {
        if (!controller.signal.aborted)
          setOption({
            product,
            available: ok && data.available === true && data.testMode === true,
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
          PostFinance Pay <small>Essai privé</small>
        </a>
      ) : (
        <span className="swiss-payment-unavailable">
          PostFinance Pay <small>Pas encore disponible</small>
        </span>
      )}
    </div>
  );
}
