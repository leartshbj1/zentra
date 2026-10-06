import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { requireZentraUser } from '@/app/zentra-auth';
import { database, runtimeValue } from '@/lib/runtime';
import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { AUTOMATION_TERMS_VERSION } from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { getSiteLanguage } from '@/lib/site-language-server';
import { publicSiteUrl } from '@/lib/site-url';
import { prepaidProduct } from '@/lib/payments/prepaid-catalog';
import {
  ownedPostFinanceTargets,
  postFinancePurchaseOption,
} from '@/lib/payments/postfinance-option';
import {
  originalPurchasePath,
  postFinancePurchasePath,
  validPostFinanceTargetId,
} from '@/lib/payments/postfinance-client-navigation';
import { PostFinanceCheckout } from '@/components/account/postfinance-checkout';

export const dynamic = 'force-dynamic';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams,
    product = prepaidProduct(query.produit);
  if (
    !product ||
    ['entreprise', 'espace'].some(
      (key) =>
        query[key] !== undefined && !validPostFinanceTargetId(query[key]),
    )
  )
    notFound();
  const org =
      typeof query.entreprise === 'string' ? query.entreprise : undefined,
    workspace = typeof query.espace === 'string' ? query.espace : undefined;
  if (!product.support && workspace) notFound();
  const user = await requireZentraUser(
    postFinancePurchasePath(product.productKey, org, workspace),
    { offerAccess: false },
  );
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get('host');
  const canonical = new URL(publicSiteUrl()).origin;
  // Canonical navigation has already removed aliases; do not use a supplied
  // query or Origin to turn on a differently configured merchant return URL.
  const requestOrigin =
    forwardedHost === new URL(canonical).host ? canonical : '';
  const option = await postFinancePurchaseOption(
    product.productKey,
    requestOrigin,
    async () => user,
    runtimeValue,
  );
  if (!option.available)
    return (
      <>
        <h1>PostFinance Pay</h1>
        <p className="account-lead">
          Ce moyen de paiement n’est pas encore disponible.
        </p>
        <a
          className="account-button"
          href={originalPurchasePath(product.productKey, org, workspace)}
        >
          Continuer par carte ou TWINT
        </a>
      </>
    );
  const targets = await ownedPostFinanceTargets(
    database(),
    user.userId,
    product.productKind === 'complete',
  );
  if (org && !targets.organizations.some((item) => item.id === org)) notFound();
  if (workspace && !targets.workspaces.some((item) => item.id === workspace))
    notFound();
  const chosenWorkspace = targets.workspaces.find(
    (item) => item.id === workspace,
  );
  if (
    org &&
    chosenWorkspace?.organizationId &&
    chosenWorkspace.organizationId !== org
  )
    notFound();
  if (
    product.productKind === 'support' &&
    org &&
    chosenWorkspace &&
    chosenWorkspace.organizationId !== org
  )
    notFound();
  if (
    product.productKind === 'complete' &&
    org &&
    workspace &&
    targets.workspaces.some(
      (item) => item.organizationId === org && item.id !== workspace,
    )
  )
    notFound();
  const version =
    product.productKind === 'gestion'
      ? LEGAL_VERSION
      : product.productKind === 'support'
        ? SUPPORT_LEGAL_VERSION
        : product.productKind === 'complete'
          ? COMPLETE_TERMS_VERSION
          : AUTOMATION_TERMS_VERSION;
  const conditions =
    product.productKind === 'gestion'
      ? '/conditions'
      : product.productKind === 'support'
        ? '/support/conditions'
        : product.productKind === 'complete'
          ? '/complet/conditions'
          : '/automation/conditions';
  return (
    <PostFinanceCheckout
      key={
        user.userId +
        ':' +
        product.productKey +
        ':' +
        (org ?? '') +
        ':' +
        (workspace ?? '')
      }
      ownerId={user.userId}
      product={product}
      targets={targets}
      methods={option.methods}
      initialOrganization={org}
      initialWorkspace={workspace}
      legalVersion={version}
      consentVersion={
        product.productKind === 'automation'
          ? AUTOMATION_CONSENT_VERSION
          : undefined
      }
      conditionsHref={conditions}
      language={await getSiteLanguage()}
    />
  );
}
