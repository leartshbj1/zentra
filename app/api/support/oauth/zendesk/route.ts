import { zendeskCallback, supportError } from '@/lib/support/service';
import { resolveSiteLanguage, SITE_LANGUAGE_TAGS } from '@/lib/site-language';
import { siteServiceCopy } from '@/lib/site-service-copy';
import { translateSiteUi } from '@/lib/site-copy';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return await zendeskCallback(request);
  } catch (error) {
    const result = supportError(error);
    const body = (await result.json()) as { error: string };
    const language=resolveSiteLanguage(request);
    // A fixed local page, not an externally supplied redirect. No provider secrets or codes in errors.
    const message = translateSiteUi(body.error,language)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return new Response(
      `<!doctype html><html lang="${SITE_LANGUAGE_TAGS[language]}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${siteServiceCopy('zendeskTitle',language)}</title><main><h1>${siteServiceCopy('zendeskHeading',language)}</h1><p>${message}</p><p><a href="/support/espace?section=connections">${siteServiceCopy('zendeskReturn',language)}</a></p></main></html>`,
      {
        status: result.status,
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Content-Language': SITE_LANGUAGE_TAGS[language],
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy':
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      },
    );
  }
}
