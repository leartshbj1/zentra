import { DeploymentProfileError, deploymentProfile, isSandboxDeployment, sandboxPublicSiteUrl } from './deployment-contract';

const FALLBACK_SITE_URL = 'https://zentraapp.ch';

export function publicSiteUrl() {
  if (isSandboxDeployment) return sandboxPublicSiteUrl();
  const configured =
    process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (!configured) return FALLBACK_SITE_URL;

  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return FALLBACK_SITE_URL;
    }
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return FALLBACK_SITE_URL;
  }
}

export function absoluteSiteUrl(path = '/') {
  const url = new URL(path, `${publicSiteUrl()}/`);
  if (isSandboxDeployment && url.origin !== deploymentProfile.siteOrigin) throw new DeploymentProfileError();
  return url.toString();
}
