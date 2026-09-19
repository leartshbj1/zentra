import { zendeskCallback, supportError } from '@/lib/support/service';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return await zendeskCallback(request);
  } catch (error) {
    const result = supportError(error);
    const body = (await result.json()) as { error: string };
    // A fixed local page, not an externally supplied redirect. No provider secrets or codes in errors.
    const message = body.error
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return new Response(
      `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion Zendesk · Zentra</title><main><h1>Connexion à reprendre</h1><p>${message}</p><p><a href="/support/espace?section=connections">Revenir à mes connexions</a></p></main></html>`,
      {
        status: result.status,
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy':
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      },
    );
  }
}
