'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  ArrowLeftRight,
  Check,
  ChevronDown,
  Play,
  ShieldCheck,
} from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { trackPilotEvent } from '@/lib/us-pilot/analytics';
import { usManagement, usMarket, usPilotQuestions } from '@/lib/markets/us';
import { PilotForm } from './pilot-form';
import { WorkflowDemo } from './workflow-demo';

const how = [
  [
    'Connect',
    'Your customers, inbox and business operations live in one place.',
  ],
  ['Understand', 'Zentra identifies what incoming information means.'],
  ['Automate', 'Routine actions can be handled automatically.'],
  [
    'Stay in control',
    'Your team reviews what matters and keeps visibility over every operation.',
  ],
];
const before = [
  'Email arrives',
  'Employee reads it',
  'Downloads attachment',
  'Copies information',
  'Opens another application',
  'Creates record',
  'Forwards information',
];
const after = [
  'Email arrives',
  'Zentra understands',
  'Information extracted',
  'Workflow prepared',
  'Human reviews when necessary',
];

export function UsLanding() {
  const [open, setOpen] = useState(false);
  const [playSignal, setPlaySignal] = useState(0);
  const viewed = useRef(false);
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = usMarket.locale;
    if (!viewed.current) {
      viewed.current = true;
      trackPilotEvent('page_view');
    }
    return () => {
      document.documentElement.lang = previous;
    };
  }, []);
  function apply(placement: string) {
    trackPilotEvent('pilot_cta_clicked', { placement });
    setOpen(true);
  }
  function watch() {
    setPlaySignal((value) => value + 1);
    document.getElementById('zentra-in-action')?.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }
  return (
    <div className="us-page" lang="en-US">
      <a className="site-skip-link" href="#us-main">
        Skip to content
      </a>
      <header className="us-header">
        <a href="/us" aria-label="Zentra US home">
          <BrandWordmark className="us-wordmark" />
        </a>
        <nav aria-label="US navigation">
          <a href="#us-management">Management</a>
          <a href="#how-it-works">How it works</a>
          <a href="#us-workflows">Workflows</a>
          <a href="#us-pilot">US pilot</a>
        </nav>
        <Button
          className="us-button us-button-primary us-header-cta"
          onClick={() => apply('header')}
        >
          Join the US Pilot
          <ArrowUpRight aria-hidden="true" />
        </Button>
      </header>
      <main id="us-main">
        <section className="us-hero" aria-labelledby="us-title">
          <div className="us-hero-copy">
            <h1 id="us-title">
              Run your business.
              <br />
              <span>
                Let Zentra handle
                <br className="us-desktop-break" /> the busywork.
              </span>
            </h1>
            <p className="us-launch-note">{usMarket.launchMessage}</p>
            <p className="us-hero-subtitle">
              Customer management, projects, estimates, invoicing and your
              business inbox — together, with AI to take repetitive admin off
              your team’s plate.
            </p>
            <p className="us-offer-note">
              <Check size={17} aria-hidden="true" />
              {usMarket.pilot.promise}
            </p>
            <div className="us-hero-actions">
              <Button
                className="us-button us-button-primary"
                onClick={() => apply('hero')}
              >
                Join the US Pilot
                <ArrowRight aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                className="us-button us-button-secondary"
                onClick={watch}
              >
                <Play size={16} aria-hidden="true" />
                Watch Zentra in Action
              </Button>
            </div>
            <p className="us-pilot-note">
              Join the US pilot ahead of launch. {usMarket.pilot.timing}
            </p>
          </div>
          <div className="us-hero-product">
            <WorkflowDemo hero playSignal={playSignal} />
            <p className="us-hero-availability">
              Explore the direction of the US pilot. Inbox integrations and
              automated actions shown here are proposed workflows.
            </p>
          </div>
          <div className="us-hero-bottom">
            <span>AI-powered business operations for SMBs.</span>
            <a href="#us-problem">
              Less admin. More business.
              <ChevronDown size={16} aria-hidden="true" />
            </a>
          </div>
        </section>
        <section className="us-section us-problem" id="us-problem">
          <div>
            <h2>
              Your business shouldn’t
              <br />
              run on copy-paste.
            </h2>
            <p>
              Read the email. Enter the details. Forward the request. Update the
              system. Create the record. Chase the next task.
            </p>
            <p className="us-problem-answer">
              Zentra turns those interactions
              <br />
              into structured actions.
            </p>
          </div>
          <div
            className="us-problem-visual"
            aria-label="Information becomes a reviewable action"
          >
            <span>Incoming information</span>
            <div className="us-problem-inputs">
              <span>Emails</span>
              <span>Requests</span>
              <span>Documents</span>
            </div>
            <ArrowRight aria-hidden="true" />
            <strong>Zentra</strong>
            <ArrowRight aria-hidden="true" />
            <span className="us-problem-output">
              <Check size={17} aria-hidden="true" />
              Ready for your team
            </span>
          </div>
        </section>
        <section
          className="us-section us-management"
          id="us-management"
          aria-labelledby="us-management-title"
        >
          <div className="us-section-intro">
            <div>
              <h2 id="us-management-title">
                From the first estimate
                <br />
                to the final invoice.
              </h2>
              <p className="us-management-name">
                Zentra Management, coming to the US.
              </p>
            </div>
            <p>
              Run the day-to-day business in one workspace. Zentra’s existing
              management product is the foundation for a US experience built
              around the way your team works.
            </p>
          </div>
          <ol
            className="us-business-flow"
            aria-label="A connected customer-to-invoice workflow"
          >
            {[
              ['Customer', 'Keep the relationship'],
              ['Estimate', 'Define the work'],
              ['Project', 'Deliver the job'],
              ['Invoice', 'Bill with the context'],
            ].map(([title, text], index) => (
              <li key={title}>
                <div>
                  <strong>{title}</strong>
                  <span>{text}</span>
                </div>
                {index < 3 && <ArrowRight size={20} aria-hidden="true" />}
              </li>
            ))}
          </ol>
          <ul className="us-management-features">
            {usManagement.map(({ title, text }) => (
              <li key={title}>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
          <p className="us-product-footnote">
            These capabilities come from Zentra’s existing product. US
            availability and the features included in your pilot will be
            confirmed before access starts. The workflow above is illustrative.
          </p>
        </section>
        <section className="us-section us-how" id="how-it-works">
          <h2>
            A little less manual.
            <br />A lot more connected.
          </h2>
          <div className="us-how-list">
            {how.map(([title, text], index) => (
              <article key={title}>
                <span className="us-step-number">0{index + 1}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
          <p className="us-control-note">
            <ShieldCheck size={18} aria-hidden="true" />
            Automation prepares the work. You decide what moves forward.
          </p>
        </section>
        <section className="us-section us-workflows" id="us-workflows">
          <div className="us-section-intro">
            <h2>
              One message.
              <br />
              Multiple actions.
            </h2>
            <p>
              An invoice. A customer request. A meeting confirmation. See how
              incoming information could become work your team can act on.
            </p>
          </div>
          <WorkflowDemo />
          <p className="us-workflow-availability">
            {usMarket.availability} Tax amounts are sample source data, not US
            tax calculations.
          </p>
        </section>
        <section className="us-section us-ecosystem" id="us-product">
          <div className="us-section-intro">
            <h2>
              One business.
              <br />
              One connected picture.
            </h2>
            <p>
              Keep the context with the work, from the first message to the next
              business decision.
            </p>
          </div>
          <div className="us-product-line">
            <article>
              <h3>Zentra Management</h3>
              <span className="us-product-status">US version coming soon</span>
              <p>
                Customer management, projects, vendors, documents and day-to-day
                operations.
              </p>
              <p className="us-product-detail">
                Estimates, sales orders, purchase orders and invoices keep the
                work connected. One workspace for the team.
              </p>
            </article>
            <span className="us-product-link" aria-label="connected to">
              <ArrowLeftRight size={22} aria-hidden="true" />
            </span>
            <article>
              <h3>Zentra Support</h3>
              <span className="us-product-status">
                Planned for the US pilot
              </span>
              <p>
                A smarter inbox that understands and organizes incoming business
                communication.
              </p>
              <p className="us-product-detail">
                Classification, priority and routing, with your team in the
                loop.
              </p>
            </article>
            <span className="us-product-link" aria-label="connected to">
              <ArrowLeftRight size={22} aria-hidden="true" />
            </span>
            <article>
              <h3>Zentra Automation</h3>
              <span className="us-product-status">
                Planned for the US pilot
              </span>
              <p>
                Connect information with actions and automate repetitive
                workflows.
              </p>
              <p className="us-product-detail">
                Reviewable records and the next action, prepared from the same
                information.
              </p>
            </article>
          </div>
          <p className="us-product-footnote">
            The US version is coming. Management, Support and Automation are
            being shaped for US businesses. The AI demos are previews of planned
            workflows; specific US features and integrations will be confirmed
            before your pilot starts.
          </p>
        </section>
        <section className="us-section us-comparison">
          <h2>
            Keep the work.
            <br />
            Lose the handoffs.
          </h2>
          <div className="us-comparison-columns">
            <div className="us-before">
              <h3>Before Zentra</h3>
              <ol>
                {before.map((item) => (
                  <li key={item}>
                    <ChevronDown size={14} aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ol>
            </div>
            <div className="us-after">
              <h3>
                With Zentra <span>Proposed pilot workflow</span>
              </h3>
              <ol>
                {after.map((item) => (
                  <li key={item}>
                    <Check size={17} aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ol>
              <p>
                Visibility at every step.
                <br />
                Human review where it matters.
              </p>
            </div>
          </div>
        </section>
        <section className="us-pilot-section" id="us-pilot">
          <div>
            <h2>
              Zentra is coming
              <br />
              to the United States.
            </h2>
            <p>
              Get in early. Help shape business software around your customers,
              your team and the work that keeps your business moving.
            </p>
            <p>
              Join the US pilot for early access, one month free and direct
              contact with the team building Zentra. Tell us what slows you down
              and help shape what comes next.
            </p>
            <Button
              className="us-button us-button-light"
              onClick={() => apply('pilot')}
            >
              Apply for Early Access
              <ArrowRight aria-hidden="true" />
            </Button>
            <p className="us-pilot-fit">
              Designed with service businesses of roughly 5–30 people in mind.
              Agencies, consultants, contractors and other SMBs are welcome.
            </p>
          </div>
          <div className="us-pilot-side">
            <span>
              Your first month
              <br />
              is on us.
            </span>
            <ul className="us-pilot-benefits">
              {[
                '1 month free when US access starts',
                'No credit card required',
                'No commitment or automatic renewal',
                'Direct access to the team',
              ].map((benefit) => (
                <li key={benefit}>
                  <Check size={18} aria-hidden="true" />
                  {benefit}
                </li>
              ))}
            </ul>
            <p className="us-pilot-terms">{usMarket.pilot.terms}</p>
          </div>
        </section>
        <section
          className="us-section us-pilot-faq"
          aria-labelledby="us-pilot-faq-title"
        >
          <h2 id="us-pilot-faq-title">A few things to know.</h2>
          <div>
            {usPilotQuestions.map(({ question, answer }) => (
              <details key={question}>
                <summary>
                  {question}
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="us-footer">
        <div>
          <a href="/us" aria-label="Zentra US home">
            <BrandWordmark className="us-wordmark" />
          </a>
          <p>AI-powered business operations for SMBs.</p>
        </div>
        <nav aria-label="Footer navigation">
          <a href="/us/privacy">Privacy</a>
          <a href="mailto:leartshabija@gmail.com">
            Contact the team
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <a href="/">
            Zentra Switzerland
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </nav>
        <span>© 2026 Zentra</span>
      </footer>
      <PilotForm open={open} onOpenChange={setOpen} />
    </div>
  );
}
