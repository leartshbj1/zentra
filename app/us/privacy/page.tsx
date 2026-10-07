import type { Metadata } from 'next';
import { BrandWordmark } from '@/components/brand-mark';
import { absoluteSiteUrl } from '@/lib/site-url';
import '../us.css';
export const metadata: Metadata = {
  title: { absolute: 'US Pilot Privacy Notice — Zentra' },
  description:
    'How Zentra uses US pilot applications and measures interest in the pilot.',
  alternates: { canonical: absoluteSiteUrl('/us/privacy') },
};
export default function UsPrivacy() {
  return (
    <div className="us-page us-privacy" lang="en-US">
      <a href="/us" aria-label="Back to Zentra US">
        <BrandWordmark className="us-wordmark" />
      </a>
      <main>
        <h1>US pilot privacy notice</h1>
        <p>Updated October 7, 2026</p>
        <h2>Your application</h2>
        <p>
          We collect the contact details, company information and answers you
          submit to assess your fit for the US pilot and contact you about a
          demo or participation. Applying does not create an account,
          subscription or payment obligation.
        </p>
        <p>
          Applications are stored in Zentra’s Supabase database in Switzerland.
          Access is restricted to the server and authorized database
          administrators; public visitors cannot read applications. Please avoid
          sending sensitive client, financial or personal information in your
          answers.
        </p>
        <h2>Measuring interest</h2>
        <p>
          We record page visits, demo interactions, pilot button clicks, form
          starts and saved applications. Measurement uses a random
          browser-session identifier and campaign tags from the URL. We do not
          send your name, email or form answers as analytics properties. Session
          storage keeps that identifier and campaign attribution while your
          browser session lasts.
        </p>
        <p>
          Optional interaction tracking respects your browser’s Do Not Track and
          Global Privacy Control signals. The application itself is still saved
          when you apply. IP-derived hashes are used for short-lived abuse
          prevention; raw IP addresses are not stored in the pilot tables.
        </p>
        <h2>Questions or deletion requests</h2>
        <p>
          Contact{' '}
          <a href="mailto:leartshabija@gmail.com">leartshabija@gmail.com</a> to
          ask about your application, correct it or request deletion. We keep
          applications while evaluating the pilot and any resulting business
          relationship, and remove information that is no longer needed.
        </p>
        <a href="/us">Return to the US pilot</a>
      </main>
    </div>
  );
}
