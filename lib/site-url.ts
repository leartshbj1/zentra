const FALLBACK_SITE_URL = 'https://elyko.alb-leart1.chatgpt.site';

export function publicSiteUrl() {
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
  return new URL(path, `${publicSiteUrl()}/`).toString();
}
