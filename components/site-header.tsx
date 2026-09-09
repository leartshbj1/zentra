import { ArrowUpRight } from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { MobileNavigation } from '@/components/mobile-navigation';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AccountLink } from '@/components/account-link';

const navigation = [
  ['/#workflow', 'Produit'],
  ['/features', 'Fonctionnalités'],
  ['/pricing', 'Tarifs'],
  ['/security', 'Sécurité & données'],
  ['/download', 'Télécharger'],
] as const;

export function SiteHeader() {
  return (
    <header className="site-header sticky top-0 z-40 border-b border-[#dedee3]/75 bg-[#f5f5f7]/92 backdrop-blur-xl">
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
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <AccountLink className="px-1 sm:px-2" />
          <MobileNavigation />
          <a
            href="/demo-facture"
            className={cn(
              buttonVariants({ size: 'lg' }),
              'hidden h-11 rounded-full bg-[#173d2c] px-4 text-sm text-white hover:bg-[#24563f] sm:inline-flex',
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
