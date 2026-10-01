import type { ReactNode } from 'react';
import { PageDisclosures } from './page-disclosures';

export function ProductHero({
  title,
  description,
  href,
  action,
  price,
  priceHref,
  children,
}: {
  title: ReactNode;
  description: string;
  href: string;
  action: string;
  price?: string;
  priceHref?: string;
  children?: ReactNode;
}) {
  return (
    <section className="quiet-hero quiet-width">
      <h1>{title}</h1>
      <div className="apple-hero-context">
        <p>{description}</p>
        <div className="quiet-actions">
          <a className="quiet-primary" href={href}>
            {action}
          </a>
          {price && (
            <a className="quiet-link" href={priceHref}>
              {price}
            </a>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

export function ProductDetails({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="quiet-section quiet-width" id={id}>
      <PageDisclosures />
      <h2>{title}</h2>
      <div className="quiet-details">{children}</div>
    </section>
  );
}
