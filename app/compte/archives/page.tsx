import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from '@/app/chatgpt-auth';
import { membershipsForUser } from '@/lib/account';
import { database } from '@/lib/runtime';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Download,
  LogOut,
  Search,
  ShieldCheck,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type ArchiveRow = {
  archive_id: string;
  invoice_number: string;
  revision: number;
  issue_date: string;
  retention_until: string;
  stored_at: number;
  content_sha256: string;
};

function parameter(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function archivePageUrl(input: {
  organizationId: string;
  page: number;
  query: string;
}): string {
  const params = new URLSearchParams({
    organizationId: input.organizationId,
    page: String(input.page),
  });
  if (input.query) params.set('q', input.query);
  return `/compte/archives?${params.toString()}`;
}

export default async function AccountArchivesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParameters = await searchParams;
  const requestedOrganizationId = parameter(
    rawParameters.organizationId,
  ).trim();
  const query = parameter(rawParameters.q).trim().slice(0, 100);
  const requestedPage = Math.max(
    1,
    Math.min(100_000, Number.parseInt(parameter(rawParameters.page), 10) || 1),
  );
  const returnTo = archivePageUrl({
    organizationId: requestedOrganizationId,
    page: requestedPage,
    query,
  });
  const user = await getChatGPTUser();
  if (!user) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f4ee] px-5 py-14 text-[#173d2c]">
        <div className="w-full max-w-xl rounded-[2rem] border border-[#d9d4c9] bg-white p-8 shadow-[0_30px_90px_rgba(29,45,35,.1)] sm:p-10">
          <ShieldCheck className="size-11 text-[#a66b1f]" />
          <h1 className="mt-5 text-4xl font-semibold tracking-[-.04em]">
            Archives Zentra
          </h1>
          <p className="mt-4 leading-7 text-[#5f6962]">
            Connectez-vous pour retrouver les PDF conservés par votre
            entreprise.
          </p>
          <a
            href={chatGPTSignInPath(returnTo)}
            className="mt-7 inline-flex min-h-12 items-center rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
          >
            Se connecter en sécurité
          </a>
        </div>
      </main>
    );
  }

  const memberships = await membershipsForUser(user.userId);
  const organization = requestedOrganizationId
    ? memberships.find(
        (membership) => membership.organizationId === requestedOrganizationId,
      )
    : memberships[0];

  if (!organization) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f4ee] px-5 py-14 text-[#173d2c]">
        <div className="w-full max-w-xl rounded-[2rem] border border-[#e2c98e] bg-[#fff8e9] p-8">
          <Archive className="size-10 text-[#a66b1f]" />
          <h1 className="mt-5 text-3xl font-semibold">Archive inaccessible</h1>
          <p className="mt-3 leading-7 text-[#6e6044]">
            Cette entreprise n’est pas reliée à votre compte Zentra.
          </p>
          <a
            href="/compte"
            className="mt-6 inline-flex min-h-11 items-center rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white"
          >
            Retour à mon compte
          </a>
        </div>
      </main>
    );
  }

  const db = database();
  const filter = `organization_id=? AND storage_status='stored'
    AND (?='' OR instr(lower(invoice_number),lower(?))>0 OR instr(issue_date,?)>0)`;
  const count = await db
    .prepare(`SELECT COUNT(*) AS count FROM invoice_archives WHERE ${filter}`)
    .bind(organization.organizationId, query, query, query)
    .first<{ count: number }>();
  const total = count?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const rows = await db
    .prepare(
      `SELECT archive_id,invoice_number,revision,issue_date,retention_until,
              stored_at,content_sha256
         FROM invoice_archives
        WHERE ${filter}
        ORDER BY issue_date DESC,invoice_number DESC,revision DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(
      organization.organizationId,
      query,
      query,
      query,
      PAGE_SIZE,
      (page - 1) * PAGE_SIZE,
    )
    .all<ArchiveRow>();

  return (
    <main className="min-h-screen bg-[#f6f4ee] px-5 py-10 text-[#173d2c] sm:py-14">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <a href="/compte" className="text-sm font-semibold text-[#52645a]">
              ← Mon compte
            </a>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[.18em] text-[#a66b1f]">
              {organization.organizationName}
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-[-.04em] sm:text-5xl">
              Coffre de factures
            </h1>
            <p className="mt-3 max-w-2xl leading-7 text-[#5f6962]">
              Ces PDF restent téléchargeables jusqu’à leur date de conservation,
              même après la fin de l’abonnement. Chaque ouverture revérifie leur
              empreinte.
            </p>
          </div>
          <a
            href={chatGPTSignOutPath(returnTo)}
            className="inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-full border border-[#c8c4ba] bg-white px-5 text-sm font-semibold"
          >
            <LogOut className="size-4" /> Déconnexion
          </a>
        </header>

        {memberships.length > 1 ? (
          <nav className="mt-8 flex flex-wrap gap-2" aria-label="Entreprises">
            {memberships.map((membership) => (
              <a
                key={membership.organizationId}
                href={archivePageUrl({
                  organizationId: membership.organizationId,
                  page: 1,
                  query: '',
                })}
                aria-current={
                  membership.organizationId === organization.organizationId
                    ? 'page'
                    : undefined
                }
                className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold ${
                  membership.organizationId === organization.organizationId
                    ? 'border-[#173d2c] bg-[#173d2c] text-white'
                    : 'border-[#cbc7bd] bg-white'
                }`}
              >
                {membership.organizationName}
              </a>
            ))}
          </nav>
        ) : null}

        <form
          method="get"
          className="mt-8 flex flex-col gap-3 rounded-3xl border border-[#d9d4c9] bg-white p-4 sm:flex-row"
        >
          <input
            type="hidden"
            name="organizationId"
            value={organization.organizationId}
          />
          <label className="relative flex-1">
            <span className="sr-only">Numéro ou date de facture</span>
            <Search className="pointer-events-none absolute left-4 top-3.5 size-5 text-[#758078]" />
            <input
              type="search"
              name="q"
              defaultValue={query}
              maxLength={100}
              placeholder="Rechercher un numéro ou une date…"
              className="h-12 w-full rounded-2xl border border-[#cbc7bd] bg-[#fffdf9] pl-12 pr-4 outline-none"
            />
          </label>
          <button
            type="submit"
            className="inline-flex min-h-12 items-center justify-center rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
          >
            Rechercher
          </button>
        </form>

        <div className="mt-6 flex items-center justify-between text-sm text-[#667168]">
          <p>
            {total} version{total === 1 ? '' : 's'} archivée
            {total === 1 ? '' : 's'}
          </p>
          <p>
            Page {page} / {pageCount}
          </p>
        </div>

        {rows.results.length === 0 ? (
          <section className="mt-5 rounded-[2rem] border border-[#d9d4c9] bg-white p-8 text-center">
            <Archive className="mx-auto size-10 text-[#a66b1f]" />
            <h2 className="mt-4 text-2xl font-semibold">Aucun résultat</h2>
            <p className="mt-2 text-[#667168]">
              Modifiez la recherche ou archivez une facture depuis Zentra.
            </p>
          </section>
        ) : (
          <ul className="mt-5 overflow-hidden rounded-[2rem] border border-[#d9d4c9] bg-white px-5 sm:px-7">
            {rows.results.map((archive) => (
              <li
                key={archive.archive_id}
                className="flex flex-col gap-4 border-b border-[#e7e3da] py-6 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-semibold">
                    {archive.invoice_number} · version {archive.revision}
                  </p>
                  <p className="mt-1 text-sm text-[#667168]">
                    Émise le {archive.issue_date} · conservée jusqu’au{' '}
                    {archive.retention_until}
                  </p>
                  <p className="mt-2 truncate font-mono text-[11px] text-[#839087]">
                    SHA-256 {archive.content_sha256}
                  </p>
                </div>
                <a
                  href={`/api/archive/account/${encodeURIComponent(archive.archive_id)}`}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-[#b9c8bd] px-5 text-sm font-semibold"
                >
                  <Download className="size-4" /> Télécharger
                </a>
              </li>
            ))}
          </ul>
        )}

        <nav
          className="mt-7 flex items-center justify-between"
          aria-label="Pagination"
        >
          {page > 1 ? (
            <a
              href={archivePageUrl({
                organizationId: organization.organizationId,
                page: page - 1,
                query,
              })}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[#cbc7bd] bg-white px-5 text-sm font-semibold"
            >
              <ChevronLeft className="size-4" /> Précédent
            </a>
          ) : (
            <span />
          )}
          {page < pageCount ? (
            <a
              href={archivePageUrl({
                organizationId: organization.organizationId,
                page: page + 1,
                query,
              })}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[#cbc7bd] bg-white px-5 text-sm font-semibold"
            >
              Suivant <ChevronRight className="size-4" />
            </a>
          ) : null}
        </nav>
      </div>
    </main>
  );
}
