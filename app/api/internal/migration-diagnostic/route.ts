import { env } from 'cloudflare:workers';
import { database } from '@/lib/runtime';
import { runMigrationDiagnostic } from '@/lib/migration-diagnostic';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return runMigrationDiagnostic(request, {
    // Dedicated ephemeral server binding. Never a URL parameter or client value.
    token: () =>
      (env as unknown as { ZENTRA_MIGRATION_DIAGNOSTIC_TOKEN?: unknown })
        .ZENTRA_MIGRATION_DIAGNOSTIC_TOKEN,
    database,
  });
}
