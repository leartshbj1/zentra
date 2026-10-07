/** Market content is separate from the Swiss product's currency and tax rules. */
export const usMarket = {
  country: 'US',
  locale: 'en-US',
  currency: 'USD',
  path: '/us',
  title: 'Zentra — AI-Powered Business Operations for SMBs',
  description:
    'Zentra brings your customers, operations and inbox together and automates repetitive business workflows with AI.',
  // No Swiss tax logic or product entitlement is changed by this market experiment.
  demoMode: 'pilot-preview' as const,
  launchMessage: 'Coming soon to the United States.',
  pilot: {
    offerId: 'us-pilot-free-month-v1',
    freeMonths: 1,
    startsOn: 'us-access-activation',
    autoRenew: false,
    paymentMethodRequired: false,
    promise: '1 month free. No credit card. No commitment.',
    timing: 'Your free month starts when your US pilot access is activated.',
    terms:
      'Applications are reviewed for pilot fit. Your free month begins when your US access is activated. There is no automatic renewal or charge. Continuing afterward is optional and requires you to choose a paid plan.',
  },
  availability:
    'US workflows are being developed for the pilot. These interactive previews use sample data; they do not connect to an inbox or create records.',
};

export const usManagement = [
  {
    title: 'Customer management',
    text: 'Keep customer contacts, project history and business documents together. Give your team the context to follow up.',
  },
  {
    title: 'Estimates & invoicing',
    text: 'Prepare estimates, track sales orders and create invoices without starting over at every step.',
  },
  {
    title: 'Projects & jobs',
    text: 'Connect project documents, budgets and time tracking. Keep the details of each job in one place.',
  },
  {
    title: 'Vendors & purchasing',
    text: 'Organize vendors, purchase orders and vendor bills alongside the work they support.',
  },
  {
    title: 'Business documents',
    text: 'Keep estimates, orders, invoices and supporting files linked to the right customer or project.',
  },
  {
    title: 'Team collaboration',
    text: 'Bring your team into the same workspace, with shared context and access controls.',
  },
] as const;

export const usPilotQuestions = [
  {
    question: 'Is Zentra available in the US today?',
    answer:
      'The US version is coming. Apply now to join the pilot ahead of launch. We’ll contact you about next steps and confirm the features available before activating your access.',
  },
  {
    question: 'When does my free month start?',
    answer:
      'When your US pilot access is activated, not when you submit this form. Applying reserves your interest in the pilot; it does not start a trial or create an account.',
  },
  {
    question: 'Do I need a credit card or a contract?',
    answer:
      'No credit card and no long-term commitment are required for your free month. There is no automatic renewal or charge. Continuing afterward is optional and requires you to choose a paid plan.',
  },
  {
    question: 'Who is the US pilot for?',
    answer:
      'US small businesses, especially service teams with about 5–30 employees. Agencies, consulting firms, contractors, professional services and other B2B businesses are welcome.',
  },
] as const;

export const usWorkflows = {
  invoice: {
    label: 'Vendor invoice',
    sender: 'billing@acmesupply.com',
    subject: 'Invoice #1048',
    message:
      'Hi, please find attached our invoice for September. The total is $2,840.00, including $180.00 in tax. Payment is due October 30. Thank you, Acme Supply.',
    detected: 'Vendor Invoice',
    fields: [
      ['Vendor', 'Acme Supply'],
      ['Invoice', '#1048'],
      ['Amount', '$2,840.00'],
      ['Tax', '$180.00'],
      ['Due', 'Oct 30'],
      ['Status', 'Ready for review'],
    ],
    steps: [
      'Email',
      'Classification',
      'Data extraction',
      'Business record',
      'Review',
    ],
    result: 'Invoice review workflow prepared',
  },
  request: {
    label: 'Customer request',
    sender: 'jordan@example.com',
    subject: 'Can we update our project scope?',
    message:
      'Hi team, we need to add two deliverables to our project before Friday. Can someone send an updated estimate today? Thanks, Jordan.',
    detected: 'Customer Request',
    fields: [
      ['Customer', 'Jordan'],
      ['Intent', 'Scope change'],
      ['Priority', 'High'],
      ['Route', 'Project team'],
      ['Next action', 'Review estimate'],
      ['Status', 'Ready for review'],
    ],
    steps: ['Email', 'Intent detection', 'Priority', 'Routing', 'Team'],
    result: 'Request prepared for the project team',
  },
  meeting: {
    label: 'Meeting',
    sender: 'alex@example.com',
    subject: 'Confirmed: project kickoff',
    message:
      'Our project kickoff is confirmed for October 22, 2026, at 10:00 AM Eastern Time. We will meet for 30 minutes by video call. See you then, Alex.',
    detected: 'Meeting Confirmation',
    fields: [
      ['Event', 'Project kickoff'],
      ['Date', 'Oct 22, 2026'],
      ['Time', '10:00 AM'],
      ['Time zone', 'America/New_York'],
      ['Duration', '30 minutes'],
      ['Status', 'Ready for review'],
    ],
    steps: [
      'Confirmation',
      'Date / time detection',
      'Structured information',
      'Calendar draft',
      'Review',
    ],
    result: 'Meeting workflow prepared for review',
  },
} as const;
export type UsWorkflow = keyof typeof usWorkflows;
