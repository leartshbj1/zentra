export type SupabaseServerConfiguration = {
  url: string;
  secretKey: string;
  timeoutMs?: number;
};

export type SupabaseQuery =
  | URLSearchParams
  | Readonly<Record<string, string | number | boolean>>;

export type SupabaseMutationOptions = {
  query?: SupabaseQuery;
  returning?: boolean;
  prefer?: readonly string[];
};

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ValidatedConfiguration = {
  origin: string;
  secretKey: string;
  timeoutMs: number;
};

export class SupabaseServerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(
      status === 504
        ? 'Supabase server request timed out.'
        : 'Supabase rejected a server request.',
    );
    this.name = 'SupabaseServerError';
  }
}

function decodeJwtPayload(value: string): Record<string, unknown> | null {
  const encoded = value.split('.')[1];
  if (!encoded) return null;
  try {
    const padded =
      encoded.replaceAll('-', '+').replaceAll('_', '/') +
      '='.repeat((4 - (encoded.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isServerSecret(value: string): boolean {
  if (/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(value)) return true;
  return decodeJwtPayload(value)?.role === 'service_role';
}

export function validateSupabaseServerConfiguration(
  input: SupabaseServerConfiguration,
): ValidatedConfiguration {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new Error('SUPABASE_URL is invalid.');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('SUPABASE_URL must be a safe HTTPS origin.');
  }
  const secretKey = input.secretKey.trim();
  if (!isServerSecret(secretKey)) {
    throw new Error('A Supabase server secret is required.');
  }
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('The Supabase timeout must be between 1 and 60 seconds.');
  }
  return { origin: url.origin, secretKey, timeoutMs };
}

function relationPath(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError('The Supabase relation name is invalid.');
  }
  return value;
}

function queryString(query: SupabaseQuery | undefined): string {
  if (!query) return '';
  const result =
    query instanceof URLSearchParams
      ? new URLSearchParams(query)
      : new URLSearchParams(
          Object.entries(query).map(([key, value]) => [key, String(value)]),
        );
  const encoded = result.toString();
  return encoded ? `?${encoded}` : '';
}

function hasMutationFilter(query: SupabaseQuery | undefined): boolean {
  if (!query) return false;
  const parameters =
    query instanceof URLSearchParams
      ? query
      : new URLSearchParams(
          Object.entries(query).map(([key, value]) => [key, String(value)]),
        );
  const nonFilters = new Set([
    'select',
    'order',
    'limit',
    'offset',
    'on_conflict',
  ]);
  return [...parameters.keys()].some((key) => !nonFilters.has(key));
}

function responseCode(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code)
    ? code
    : '';
}

export class SupabaseServerClient {
  readonly #configuration: ValidatedConfiguration;
  readonly #fetch: Fetch;

  constructor(configuration: SupabaseServerConfiguration, fetcher: Fetch = fetch) {
    this.#configuration = validateSupabaseServerConfiguration(configuration);
    this.#fetch = fetcher;
  }

  async select<T>(relation: string, query?: SupabaseQuery): Promise<T[]> {
    return this.#request<T[]>(
      'GET',
      `/rest/v1/${relationPath(relation)}${queryString(query)}`,
    );
  }

  async insert<T>(
    relation: string,
    values: Readonly<Record<string, unknown>> | readonly Record<string, unknown>[],
    options: SupabaseMutationOptions = {},
  ): Promise<T[]> {
    return this.#mutation<T>('POST', relation, values, options);
  }

  async upsert<T>(
    relation: string,
    values: Readonly<Record<string, unknown>> | readonly Record<string, unknown>[],
    options: SupabaseMutationOptions & { onConflict: string },
  ): Promise<T[]> {
    if (!/^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/.test(options.onConflict)) {
      throw new TypeError('The Supabase conflict target is invalid.');
    }
    const query = new URLSearchParams(
      options.query instanceof URLSearchParams
        ? options.query
        : Object.entries(options.query ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
    );
    query.set('on_conflict', options.onConflict);
    return this.#mutation<T>('POST', relation, values, {
      ...options,
      query,
      prefer: ['resolution=merge-duplicates', ...(options.prefer ?? [])],
    });
  }

  async update<T>(
    relation: string,
    values: Readonly<Record<string, unknown>>,
    options: SupabaseMutationOptions,
  ): Promise<T[]> {
    if (!hasMutationFilter(options.query)) {
      throw new TypeError('A filtered update is required.');
    }
    return this.#mutation<T>('PATCH', relation, values, options);
  }

  async delete<T>(
    relation: string,
    query: SupabaseQuery,
    options: Omit<SupabaseMutationOptions, 'query'> = {},
  ): Promise<T[]> {
    if (!hasMutationFilter(query)) {
      throw new TypeError('A filtered delete is required.');
    }
    return this.#request<T[]>(
      'DELETE',
      `/rest/v1/${relationPath(relation)}${queryString(query)}`,
      undefined,
      this.#prefer(options),
    );
  }

  async rpc<T>(
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    return this.#request<T>(
      'POST',
      `/rest/v1/rpc/${relationPath(functionName)}`,
      parameters,
      ['return=representation'],
    );
  }

  async #mutation<T>(
    method: 'POST' | 'PATCH',
    relation: string,
    values: unknown,
    options: SupabaseMutationOptions,
  ): Promise<T[]> {
    return this.#request<T[]>(
      method,
      `/rest/v1/${relationPath(relation)}${queryString(options.query)}`,
      values,
      this.#prefer(options),
    );
  }

  #prefer(options: SupabaseMutationOptions): string[] {
    const returning = options.returning ?? true;
    return [
      returning ? 'return=representation' : 'return=minimal',
      ...(options.prefer ?? []),
    ];
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    prefer: readonly string[] = [],
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#configuration.timeoutMs);
    try {
      const response = await this.#fetch(`${this.#configuration.origin}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          apikey: this.#configuration.secretKey,
          Authorization: `Bearer ${this.#configuration.secretKey}`,
          'Accept-Profile': 'public',
          'Content-Profile': 'public',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(prefer.length ? { Prefer: [...new Set(prefer)].join(',') } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          // Error bodies are deliberately not propagated to public callers.
        }
        throw new SupabaseServerError(response.status, responseCode(payload));
      }
      if (response.status === 204) {
        return [] as T;
      }
      const text = await response.text();
      if (!text) return [] as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SupabaseServerError(502, 'invalid_json');
      }
    } catch (error) {
      if (error instanceof SupabaseServerError) throw error;
      if (controller.signal.aborted) throw new SupabaseServerError(504, 'timeout');
      throw new SupabaseServerError(502, 'network_error');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createSupabaseServerClient(
  configuration: SupabaseServerConfiguration,
  fetcher?: Fetch,
) {
  return new SupabaseServerClient(configuration, fetcher);
}
