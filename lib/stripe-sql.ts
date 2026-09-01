export const UPSERT_SUBSCRIPTION_SQL = `INSERT INTO subscriptions(subscription_id,customer_id,checkout_session_id,customer_email,customer_name,price_id,status,current_period_end,cancel_at_period_end,livemode,entitlement_valid_until,last_paid_invoice_id,last_paid_at,last_payment_failure_invoice_id,last_payment_failure_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(subscription_id) DO UPDATE SET customer_id=excluded.customer_id,checkout_session_id=COALESCE(excluded.checkout_session_id,subscriptions.checkout_session_id),customer_email=COALESCE(excluded.customer_email,subscriptions.customer_email),customer_name=COALESCE(excluded.customer_name,subscriptions.customer_name),price_id=excluded.price_id,status=excluded.status,current_period_end=MAX(subscriptions.current_period_end,excluded.current_period_end),cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,entitlement_valid_until=MAX(subscriptions.entitlement_valid_until,excluded.entitlement_valid_until),last_paid_invoice_id=CASE WHEN excluded.last_paid_invoice_id IS NOT NULL AND (subscriptions.last_paid_invoice_id IS NULL OR excluded.entitlement_valid_until>subscriptions.entitlement_valid_until) THEN excluded.last_paid_invoice_id ELSE subscriptions.last_paid_invoice_id END,last_paid_at=CASE WHEN excluded.last_paid_at IS NOT NULL AND (subscriptions.last_paid_at IS NULL OR excluded.entitlement_valid_until>subscriptions.entitlement_valid_until) THEN excluded.last_paid_at ELSE subscriptions.last_paid_at END,last_payment_failure_invoice_id=CASE WHEN excluded.last_paid_at IS NOT NULL AND (subscriptions.last_payment_failure_at IS NULL OR excluded.last_paid_at>=subscriptions.last_payment_failure_at) THEN NULL WHEN excluded.last_payment_failure_at IS NOT NULL AND excluded.last_payment_failure_at>COALESCE(subscriptions.last_paid_at,0) AND (subscriptions.last_payment_failure_at IS NULL OR excluded.last_payment_failure_at>=subscriptions.last_payment_failure_at) THEN excluded.last_payment_failure_invoice_id ELSE subscriptions.last_payment_failure_invoice_id END,last_payment_failure_at=CASE WHEN excluded.last_paid_at IS NOT NULL AND (subscriptions.last_payment_failure_at IS NULL OR excluded.last_paid_at>=subscriptions.last_payment_failure_at) THEN NULL WHEN excluded.last_payment_failure_at IS NOT NULL AND excluded.last_payment_failure_at>COALESCE(subscriptions.last_paid_at,0) AND (subscriptions.last_payment_failure_at IS NULL OR excluded.last_payment_failure_at>=subscriptions.last_payment_failure_at) THEN excluded.last_payment_failure_at ELSE subscriptions.last_payment_failure_at END,updated_at=excluded.updated_at`;

export const INSERT_STRIPE_EVENT_SQL =
  'INSERT OR IGNORE INTO stripe_events(event_id,event_type,livemode,event_created_at,received_at,processing_started_at,processing_attempts,processed_at) VALUES(?,?,?,?,?,NULL,0,NULL)';

export const CLAIM_STRIPE_EVENT_SQL = `UPDATE stripe_events
  SET processing_started_at=?,processing_attempts=processing_attempts+1
  WHERE event_id=? AND processed_at IS NULL
    AND (processing_started_at IS NULL OR processing_started_at<?)`;

export const RELEASE_STRIPE_EVENT_SQL =
  'UPDATE stripe_events SET processing_started_at=NULL WHERE event_id=? AND processed_at IS NULL';

export const COMPLETE_STRIPE_EVENT_SQL =
  'UPDATE stripe_events SET processing_started_at=NULL,processed_at=? WHERE event_id=?';
