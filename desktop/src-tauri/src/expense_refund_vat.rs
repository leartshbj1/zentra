use super::*;

pub(super) fn load(
    connection: &Connection,
    form: &str,
    from: &str,
    to: &str,
) -> AppResult<Vec<RawVatSource>> {
    let date = if form == "received" {
        "payment_date"
    } else {
        "credit_date"
    };
    let mut statement=connection.prepare(&format!("SELECT r.*,CASE event_type WHEN 'refund' THEN -1 ELSE 1 END AS sign FROM expense_refunds r WHERE {date} BETWEEN ? AND ? ORDER BY {date},id"))?;
    let rows = statement.query_map(params![from, to], |row| {
        let id: String = row.get("id")?;
        let sign: i64 = row.get("sign")?;
        Ok(RawVatSource {
            source_type: "expense_refund".into(),
            source_id: id.clone(),
            parent_id: row.get("expense_id")?,
            occurrence_date: row.get(date)?,
            description: format!(
                "{} · {}",
                if sign < 0 {
                    "Remboursement de dépense"
                } else {
                    "Correction de remboursement"
                },
                row.get::<_, String>("reference")?
            ),
            currency: "CHF".into(),
            net_cents: sign * row.get::<_, i64>("net_cents")?,
            vat_cents: sign * row.get::<_, i64>("vat_cents")?,
            total_cents: sign * row.get::<_, i64>("total_cents")?,
            vat_rate_bp: None,
            classification_id: Some(id),
            treatment: row.get("treatment")?,
            classification_note: Some(
                "Traitement historique conservé depuis la dépense d’origine.".into(),
            ),
            classification_updated_at: Some(row.get("created_at")?),
            reliable: true,
            reliability_detail: None,
            received_payments: Vec::new(),
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub(super) fn append_issues(
    connection: &Connection,
    profile: &VatProfile,
    from: &str,
    to: &str,
    issues: &mut Vec<VatBlockingIssue>,
) -> AppResult<()> {
    let rows=crate::database::query_all(connection,"SELECT r.id,r.reference,r.treatment,r.vat_cents,EXISTS(SELECT 1 FROM vat_profiles a JOIN vat_profiles b ON a.form_of_reporting<>b.form_of_reporting WHERE r.credit_date BETWEEN a.effective_from AND COALESCE(a.effective_to,'9999-12-31') AND r.payment_date BETWEEN b.effective_from AND COALESCE(b.effective_to,'9999-12-31')) AS transition FROM expense_refunds r WHERE r.credit_date BETWEEN ?1 AND ?2 OR r.payment_date BETWEEN ?1 AND ?2",params![from,to])?;
    for row in rows {
        if row["treatment"] != "non_deductible"
            && row["vat_cents"].as_i64().unwrap_or_default() != 0
            && (profile.reporting_method == "simple_tax_rate"
                || row["transition"].as_i64() == Some(1))
        {
            issues.push(VatBlockingIssue{code:"expense_refund_vat_transition".into(),message:format!("Le remboursement {} traverse un changement de méthode ou de base TVA. Faites contrôler sa correction avant d’exporter ce décompte.",row["reference"].as_str().unwrap_or_default()),source_type:Some("expense_refund".into()),source_id:row["id"].as_str().map(str::to_owned)});
        }
    }
    Ok(())
}
