CREATE TABLE account_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('system','light','dark')),
  company_draft TEXT NOT NULL DEFAULT '',
  onboarding_completed_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE automation_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE account_trials (
  user_id TEXT PRIMARY KEY NOT NULL,
  email_hash TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  subscription_id TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  converted_subscription_id TEXT,
  CHECK(ends_at>started_at)
);
--> statement-breakpoint
CREATE TABLE account_session_policy (
  user_id TEXT PRIMARY KEY NOT NULL,
  revoked_before INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
