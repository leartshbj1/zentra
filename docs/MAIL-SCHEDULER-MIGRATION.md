# Mail scheduler migration provenance

The proportional dispatcher was applied to the existing Supabase project on 2026-10-05. Supabase recorded version `20261005002340` with name `proportional_mail_scheduler_dispatch`. Its prepared source had been named `20261004222250_proportional_mail_scheduler_dispatch.sql` in Sites version316.

The current filename matches the applied registry version. This is a source metadata reconciliation: the SQL bytes and SQL behavior are unchanged. Do not reapply the migration or pause/resume the cron job for this rename. The existing job remains the same and its runtime token is not contained in this repository.

Prepared SQL SHA256 (canonical Git bytes): `35874373d06a82d2be1361e46dda74289c4695e6e138b79ff11fbc1a9c1420ab`. The old deployed archive and operator receipts retain the original preparation filename for audit continuity.
