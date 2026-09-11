'use client';

import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';

export function SiteNavLink({ href, children, ...props }: ComponentProps<'a'> & { href: string }) {
  const pathname = usePathname();
  const active = href.includes('#') ? false : pathname === href;
  return <a href={href} aria-current={active ? 'page' : undefined} {...props}>{children}</a>;
}
