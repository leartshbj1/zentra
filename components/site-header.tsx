import { ArrowUpRight } from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { MobileNavigation } from '@/components/mobile-navigation';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const navigation = [
  ['/#workflow', 'Produit'],
  ['/features', 'Fonctionnalités'],
  ['/pricing', 'Tarifs'],
  ['/security', 'Sécurité & données'],
  ['/download', 'Télécharger'],
] as const;

export function SiteHeader() {
  return (
    <header className="site-header sticky top-0 z-40 border-b border-[#d9d4c9]/75 bg-[#f6f4ef]/92 backdrop-blur-xl">
      <div className="mx-auto flex min-h-[68px] w-full max-w-7xl items-center justify-between gap-4 px-5 lg:px-8">
        <a
          href="/"
          className="flex min-h-11 shrink-0 items-center"
          aria-label="Zentra, accueil"
        >
          <BrandWordmark className="w-[5.6rem] min-[360px]:w-[6.4rem] sm:w-[6.9rem]" />
        </a>

        <nav
          className="hidden items-center gap-6 text-sm font-medium text-[#536158] xl:flex"
          aria-label="Navigation principale"
        >
          {navigation.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="inline-flex min-h-11 items-center whitespace-nowrap transition-colors hover:text-[#173d2c]"
            >
              {label}
            </a>
          ))}
          <a
            href="/compte"
            className="inline-flex min-h-11 items-center whitespace-nowrap text-[#6d776f] transition-colors hover:text-[#173d2c]"
          >
            Mon compte
          </a>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <MobileNavigation />
          <a
            href="/demo-facture"
            className={cn(
              buttonVariants({ size: 'lg' }),
              'h-11 rounded-full bg-[#173d2c] px-3 text-xs text-white shadow-[0_8px_24px_rgba(23,61,44,.16)] hover:bg-[#24563f] min-[360px]:px-4 min-[390px]:px-5 min-[390px]:text-sm',
            )}
          >
            <span className="hidden min-[360px]:inline">Essayer Zentra</span>
            <span className="min-[360px]:hidden">Essayer</span>
            <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>
    </header>
  );
}
