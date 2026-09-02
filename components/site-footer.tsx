import { BrandWordmark } from '@/components/brand-mark';

const links = [
  ['/features', 'Fonctionnalités'],
  ['/pricing', 'Tarifs'],
  ['/security', 'Sécurité & données'],
  ['/download', 'Télécharger'],
  ['/confidentialite', 'Confidentialité'],
  ['/compte', 'Mon compte'],
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-[#dcd8ce] bg-[#f0eee8] px-5 py-10 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-8 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <a href="/" className="inline-flex min-h-11 items-center">
            <BrandWordmark className="w-24" />
          </a>
          <p className="mt-2 max-w-md text-sm leading-6 text-[#657068]">
            Logiciel de gestion local-first pour les PME suisses. Les limites du
            produit sont présentées aussi clairement que ses fonctions.
          </p>
          <a
            href="mailto:leartshabija@gmail.com"
            className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[#315e48] underline decoration-[#d3a35e] underline-offset-4"
          >
            leartshabija@gmail.com
          </a>
        </div>
        <div className="sm:text-right">
          <nav
            className="flex max-w-xl flex-wrap gap-x-5 gap-y-1 text-sm text-[#536158] sm:justify-end"
            aria-label="Navigation de pied de page"
          >
            {links.map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="inline-flex min-h-11 items-center"
              >
                {label}
              </a>
            ))}
          </nav>
          <p className="mt-3 text-xs text-[#788078]">© 2026 Zentra</p>
        </div>
      </div>
    </footer>
  );
}
