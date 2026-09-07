import { ArrowDownToLine, Archive, ArrowLeft, ShieldCheck } from 'lucide-react';

export type RecoveryBackup = {
  backup_id: string;
  created_at: string;
  size_bytes: number;
  app_version: string;
  state: string;
};

export function BackupRecoveryView({
  organizations,
  organizationId,
  backups,
  signInPath,
  error,
}: {
  organizations: { organizationId: string; organizationName: string }[];
  organizationId?: string;
  backups: RecoveryBackup[];
  signInPath?: string;
  error?: string;
}) {
  const copies = backups.filter((copy) => copy.state === 'complete');
  const organization = organizations.find(
    (item) => item.organizationId === organizationId,
  );
  return (
    <main className="min-h-screen bg-[#f6f4ee] px-5 py-10 text-[#173d2c] sm:py-16">
      <div className="mx-auto max-w-3xl">
        <a
          href="/compte"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Mon compte
        </a>
        <header className="mt-7">
          <p className="text-sm font-semibold text-[#81612e]">
            Récupération de l’entreprise
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-.04em] sm:text-5xl">
            Mes sauvegardes
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#5f6962]">
            Retrouvez une copie de vos données et documents, même si votre
            ordinateur ne démarre plus ou si votre abonnement est terminé.
          </p>
        </header>
        {signInPath ? (
          <section className="mt-8 rounded-3xl border border-[#d9d4c9] bg-white p-6 sm:p-8">
            <ShieldCheck className="size-8 text-[#9b7534]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold">
              Retrouver mon entreprise
            </h2>
            <p className="mt-3 leading-7 text-[#5f6962]">
              Connectez-vous avec le compte du titulaire ou d’un administrateur.
              La connexion à l’ancien appareil n’est pas nécessaire.
            </p>
            <a
              href={signInPath}
              className="mt-6 inline-flex min-h-12 items-center justify-center rounded-full bg-[#173d2c] px-6 font-semibold text-white"
            >
              Se connecter
            </a>
          </section>
        ) : error || !organization ? (
          <section
            className="mt-8 rounded-3xl border border-[#dfd3b9] bg-[#fffaf0] p-6"
          >
            <h2 className="text-xl font-semibold">Sauvegardes indisponibles</h2>
            <p className="mt-3 leading-7 text-[#68624f]">
              {error ??
                'Aucune entreprise dont vous êtes titulaire ou administrateur n’est liée à ce compte.'}
            </p>
            <a
              href="/compte/sauvegardes"
              className="mt-4 inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
            >
              Réessayer
            </a>
          </section>
        ) : (
          <>
            <section className="mt-8" aria-label="Entreprise et sauvegardes">
              {organizations.length > 1 ? (
                <form
                  method="get"
                  className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end"
                >
                  <label className="flex min-w-0 flex-1 flex-col gap-2 font-semibold">
                    Entreprise
                    <select
                      name="organizationId"
                      defaultValue={organizationId}
                      className="min-h-12 w-full rounded-xl border border-[#bdc7bb] bg-white px-3 text-base"
                    >
                      {organizations.map((item) => (
                        <option
                          key={item.organizationId}
                          value={item.organizationId}
                        >
                          {item.organizationName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="min-h-12 rounded-full border border-[#bdc7bb] px-6 font-semibold">
                    Afficher
                  </button>
                </form>
              ) : null}
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#d9d4c9] pb-4">
                <h2 className="min-w-0 break-words text-xl font-semibold">
                  {organization.organizationName}
                </h2>
                <p className="text-sm text-[#5f6962]">
                  Plus récentes en premier
                </p>
              </div>
              {copies.length ? (
                <ul className="divide-y divide-[#d9d4c9]">
                  {copies.map((copy) => (
                    <li
                      key={copy.backup_id}
                      className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold">
                          {new Intl.DateTimeFormat('fr-CH', {
                            dateStyle: 'long',
                            timeStyle: 'short',
                            timeZone: 'Europe/Zurich',
                          }).format(new Date(copy.created_at))}
                        </p>
                        <p className="mt-2 text-sm text-[#5f6962]">
                          {new Intl.NumberFormat('fr-CH', {
                            maximumFractionDigits: 1,
                          }).format(copy.size_bytes / (1024 * 1024))}{' '}
                          Mio · Zentra {copy.app_version}
                        </p>
                      </div>
                      <a
                        href={`/api/backups/account/file?${new URLSearchParams({ organizationId: organization.organizationId, id: copy.backup_id })}`}
                        className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-[#aab9a7] bg-white px-5 font-semibold"
                      >
                        <ArrowDownToLine
                          className="size-4"
                          aria-hidden="true"
                        />{' '}
                        Télécharger
                        <span className="sr-only">
                          {' '}
                          la copie du {copy.created_at}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="py-10">
                  <Archive
                    className="size-8 text-[#9b7534]"
                    aria-hidden="true"
                  />
                  <p className="mt-4 text-lg font-semibold">
                    Aucune sauvegarde complète
                  </p>
                  <p className="mt-2 leading-7 text-[#5f6962]">
                    Les copies apparaissent ici une fois leur envoi terminé
                    depuis les paramètres de Zentra.
                  </p>
                </div>
              )}
              {backups.length > copies.length ? (
                <p className="mt-3 text-sm leading-6 text-[#5f6962]">
                  {backups.length - copies.length} copie(s) incomplète(s) ou en
                  cours de suppression ne peuvent pas être téléchargées.
                </p>
              ) : null}
            </section>
            <section className="mt-8 rounded-3xl bg-[#e8eee4] p-6">
              <h2 className="text-lg font-semibold">Après le téléchargement</h2>
              <p className="mt-3 leading-7 text-[#52624f]">
                Conservez le fichier .zentra dans un emplacement privé. Il
                contient les données de l’entreprise, y compris les salaires.
                Dans Zentra, choisissez « Restaurer une sauvegarde » et
                sélectionnez ce fichier.
              </p>
              <p className="mt-3 leading-7 text-[#52624f]">
                La restauration reprend la situation à la date de cette copie et
                conserve une sauvegarde de sécurité de l’appareil. Elle ne
                fusionne pas les modifications ultérieures.
              </p>
            </section>
          </>
        )}
        <p className="mt-8 text-sm leading-6 text-[#5f6962]">
          Besoin d’aide ?{' '}
          <a
            href="mailto:leartshabija@gmail.com"
            className="break-all font-semibold underline underline-offset-4"
          >
            leartshabija@gmail.com
          </a>
        </p>
      </div>
    </main>
  );
}
