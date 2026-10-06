// Local receipts are restricted to their product and target. Remote payment
// URLs remain restricted to Stripe's HTTPS hosts, without credentials or ports.
function paymentUrl(raw: string, origin: string, hosts: string[]) {
  try {
    const url = new URL(raw, origin);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' && hosts.includes(url.hostname))
      return url.port ? null : url;
    return url.origin === new URL(origin).origin ? url : null;
  } catch {
    return null;
  }
}

export function automationPaymentUrl(
  raw: string,
  origin: string,
  organizationId: string,
) {
  const url = paymentUrl(raw, origin, [
    'checkout.stripe.com',
    'billing.stripe.com',
  ]);
  if (!url || url.origin !== new URL(origin).origin) return url;
  if (url.pathname !== '/compte/automation' || url.hash || !organizationId)
    return null;
  const entries = [...url.searchParams];
  if (
    entries.length !== 1 ||
    entries[0][0] !== 'entreprise' ||
    entries[0][1] !== organizationId
  )
    return null;
  return url;
}

export function completePaymentUrl(raw: string, origin: string) {
  const url = paymentUrl(raw, origin, ['checkout.stripe.com']);
  if (!url || url.origin !== new URL(origin).origin) return url;
  return url.pathname === '/compte' && !url.search && !url.hash ? url : null;
}
