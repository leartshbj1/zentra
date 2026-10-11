import { expect, it, vi } from 'vitest';
import { createQuoteDecisionProvider } from './provider';
import { JEV_ENDPOINT, JEV_MODEL } from '@/lib/automation/provider';

const input = {
  state: { excerpt: 'Please quote 3 radiators.' },
  questions: {
    intent: {
      instructions: 'Choose only from these options.',
      options: { quote: 'A new quote', other: 'Other' },
    },
  },
};
const answer = (model = JEV_MODEL) => ({
  model,
  answers: {
    intent: {
      type: 'choice',
      choice: 'quote',
      confidence: 0.99,
      probabilities: { quote: 1, other: 0 },
    },
  },
});

it('reuses the existing typed transport with the fixed model and no redirects', async () => {
  const authorize = vi.fn(async () => undefined);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(answer()));
  const result = await createQuoteDecisionProvider(
    'fictitious-key',
    authorize,
    { fetcher },
  ).decide(input);
  expect(result.answers.intent.choice).toBe('quote');
  expect(authorize).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(JEV_ENDPOINT);
  expect(init?.redirect).toBe('manual');
  expect(typeof init?.body).toBe('string');
  expect(JSON.parse(init?.body as string).model).toBe(JEV_MODEL);
});

it.each([429, 502, 503, 504, 529])(
  'never retries a %i response after durable start',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('private response', {
        status,
        headers: { 'retry-after': '0' },
      }),
    );
    await expect(
      createQuoteDecisionProvider('fictitious-key', async () => undefined, {
        fetcher,
      }).decide(input),
    ).rejects.toThrow(status === 429 ? 'rate_limit' : 'unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it('checks authorization immediately before HTTP and sends nothing after refusal', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    createQuoteDecisionProvider(
      'fictitious-key',
      async () => {
        throw Error('private authorization failure');
      },
      { fetcher },
    ).decide(input),
  ).rejects.toThrow('network');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['network', 'timeout'])(
  'does not resend an ambiguous %s failure',
  async (failure) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        failure === 'timeout'
          ? new DOMException('Private timeout', 'TimeoutError')
          : Error('private network detail'),
      );
    await expect(
      createQuoteDecisionProvider('fictitious-key', async () => undefined, {
        fetcher,
      }).decide(input),
    ).rejects.toThrow(failure);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it('does not accept a silent provider model substitution', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(answer('another-model')));
  await expect(
    createQuoteDecisionProvider('fictitious-key', async () => undefined, {
      fetcher,
    }).decide(input),
  ).rejects.toThrow('invalid_response');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['', 'contains\nnewline', ' '.repeat(20)])(
  'refuses invalid configuration without network access',
  (key) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      createQuoteDecisionProvider(key, async () => undefined, { fetcher }),
    ).toThrow('configuration');
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it('captures the authorization and transport references before the asynchronous attempt', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(answer()));
  const options = { fetcher };
  const provider = createQuoteDecisionProvider(
    'fictitious-key',
    async () => {
      options.fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(Error('replaced'));
    },
    options,
  );
  await expect(provider.decide(input)).resolves.toMatchObject({
    model: JEV_MODEL,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('bounds stalled authorization and never sends HTTP after its late resolution', async () => {
  let release!: () => void;
  const authorization = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    createQuoteDecisionProvider('fictitious-key', () => authorization, {
      fetcher,
      timeoutMs: 10,
    }).decide(input),
  ).rejects.toThrow('timeout');
  release();
  await authorization;
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
});
