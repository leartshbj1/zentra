import { prepaidProduct } from './prepaid-catalog';

export function validPostFinanceTargetId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180)
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function postFinancePurchasePath(
  product: string,
  organizationId?: string,
  workspaceId?: string,
) {
  const params = new URLSearchParams({ produit: product });
  if (organizationId) params.set('entreprise', organizationId);
  if (workspaceId) params.set('espace', workspaceId);
  return '/compte/paiement/nouveau?' + params;
}
export function originalPurchasePath(
  productKey: string,
  organizationId?: string,
  workspaceId?: string,
) {
  const product = prepaidProduct(productKey);
  const org = organizationId
    ? '?organizationId=' + encodeURIComponent(organizationId)
    : '';
  if (!product) return '/compte';
  if (product.productKind === 'gestion')
    return '/pricing?formule=' + product.planId;
  if (product.productKind === 'support')
    return (
      '/support/espace?section=billing' +
      (workspaceId ? '&workspace=' + encodeURIComponent(workspaceId) : '')
    );
  if (product.productKind === 'automation') return '/compte/automation' + org;
  return (
    '/complet/abonnement?formule=' +
    product.planId +
    (organizationId
      ? '&organizationId=' + encodeURIComponent(organizationId)
      : '')
  );
}
export function postFinanceHostedUrl(raw: unknown) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ['checkout.postfinance.ch', 'app-wallee.com'].includes(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}
