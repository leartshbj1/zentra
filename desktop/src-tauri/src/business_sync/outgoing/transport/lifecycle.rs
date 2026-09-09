//! Resumable server validation and commit. A verified remote commit is still
//! distinct from installing canonical positions and acknowledging local edits.
use super::*;
use crate::business_sync::replay::delivery::{fingerprint_contract, verify_outgoing_receipt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Review,
    Validation,
    Fingerprint,
    Delivery,
    Commit,
}
impl Stage {
    fn path(self) -> &'static str {
        match self {
            Self::Review => "/api/sync/transactions/review",
            Self::Validation => "/api/sync/transactions/validate",
            Self::Fingerprint => "/api/sync/transactions/fingerprint",
            Self::Delivery => "/api/sync/transactions/delivery",
            Self::Commit => "/api/sync/transactions/commit",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Review => "reviewing",
            Self::Validation => "validating",
            Self::Fingerprint => "fingerprinting",
            Self::Delivery => "preparing_delivery",
            Self::Commit => "committing",
        }
    }
}
fn require(valid: bool) -> AppResult<()> {
    if valid {
        Ok(())
    } else {
        Err(invalid("La réponse de contrôle ne correspond pas à cette opération. Les modifications locales sont conservées."))
    }
}
fn number(v: &Value, key: &str) -> AppResult<u64> {
    v[key]
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("Le compteur de contrôle reçu est invalide."))
}
fn hash(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn response(code: u16, raw: &[u8]) -> AppResult<Value> {
    require(raw.len() <= 1024 * 1024)?;
    let value: Value = serde_json::from_slice(raw)?;
    if !(200..300).contains(&code) {
        return Err(invalid(value["error"].as_str().filter(|s| s.len() < 1500)
            .unwrap_or("Le contrôle serveur est interrompu. Reprenez la synchronisation ; les modifications locales sont conservées.")));
    }
    require(value.is_object())?;
    Ok(value)
}
#[derive(Default)]
struct Proofs {
    review: Option<Value>,
    validation: Option<Value>,
    fingerprint: Option<Value>,
    delivery: Option<Value>,
}
impl Proofs {
    fn check(
        &mut self,
        stage: Stage,
        v: &Value,
        p: &Prepared,
        manifest_hash: &str,
    ) -> AppResult<(Stage, bool)> {
        let m = &p.manifest;
        require(
            v["transaction_id"] == m.transaction_id
                && v["organization_id"] == m.organization_id
                && v["installation_id"] == m.installation_id
                && v["generation"] == m.generation
                && v["canonical_committed"] == false
                && v["replication_active"] == false
                && v["attempt"].as_str().is_some_and(uuid)
                && number(v, "source_revision")? >= m.base_revision as u64
                && number(v, "source_revision")? < 9_007_199_254_740_991,
        )?;
        if stage != Stage::Delivery {
            require(v["manifest_sha256"] == manifest_hash)?;
        }
        if let Some(review) = &self.review {
            require(
                v["attempt"] == review["attempt"]
                    && v["source_revision"] == review["source_revision"],
            )?;
        }
        let phase_key = if matches!(stage, Stage::Review | Stage::Delivery) {
            "state"
        } else {
            "phase"
        };
        let phase = v[phase_key]
            .as_str()
            .ok_or_else(|| invalid("L’étape de contrôle est absente."))?;
        let stopped = matches!(phase, "invalid" | "conflict" | "stale");
        let next = match stage {
            Stage::Review => {
                require(
                    v["algorithm_version"] == 4
                        && hash(&v["validator_sha256"])
                        && v["financial_validated"] == false
                        && matches!(
                            phase,
                            "copying" | "applying" | "projected" | "invalid" | "conflict" | "stale"
                        )
                        && number(v, "applied_changes")? <= m.change_count as u64
                        && number(v, "next_chunk")? <= m.chunks.len() as u64
                        && number(v, "audit_entries")? <= m.change_count as u64
                        && v["conflicts"]
                            .as_array()
                            .is_some_and(|rows| rows.len() <= 20),
                )?;
                number(v, "copied_rows")?;
                if phase == "projected" {
                    require(
                        v["applied_changes"] == m.change_count
                            && v["next_chunk"] == m.chunks.len()
                            && v["failed_rule"].is_null()
                            && v["conflicts"].as_array().is_some_and(Vec::is_empty),
                    )?;
                }
                Self::monotonic(
                    &self.review,
                    v,
                    phase_key,
                    &[
                        "copied_rows",
                        "applied_changes",
                        "next_chunk",
                        "audit_entries",
                    ],
                    false,
                )?;
                if let Some(old) = &self.review {
                    require(old["validator_sha256"] == v["validator_sha256"])?;
                }
                self.review = Some(v.clone());
                if phase == "projected" {
                    Stage::Validation
                } else {
                    stage
                }
            }
            Stage::Validation => {
                require(
                    v["algorithm_version"] == 9
                        && hash(&v["validator_sha256"])
                        && matches!(
                            phase,
                            "pending"
                                | "structure"
                                | "accounting"
                                | "transitions"
                                | "projecting"
                                | "valid"
                                | "invalid"
                                | "stale"
                        )
                        && v["business_validated"] == false
                        && v["snapshot_validated"] == (phase == "valid")
                        && v["total_changes"] == m.change_count
                        && number(v, "checked_changes")? <= m.change_count as u64
                        && number(v, "checked_structural_rules")?
                            <= number(v, "total_structural_rules")?
                        && number(v, "checked_accounting_rules")?
                            <= number(v, "total_accounting_rules")?,
                )?;
                if phase == "valid" {
                    require(
                        v["failed_rule"].is_null()
                            && v["failed_change"].is_null()
                            && v["credit_projection"]["phase"] == "valid"
                            && v["checked_changes"] == v["total_changes"]
                            && v["checked_structural_rules"] == v["total_structural_rules"]
                            && v["checked_accounting_rules"] == v["total_accounting_rules"],
                    )?;
                }
                if let Some(old) = &self.validation {
                    for key in [
                        "validator_sha256",
                        "total_structural_rules",
                        "total_accounting_rules",
                    ] {
                        require(old[key] == v[key])?;
                    }
                }
                Self::monotonic(
                    &self.validation,
                    v,
                    phase_key,
                    &[
                        "checked_structural_rules",
                        "checked_accounting_rules",
                        "checked_changes",
                    ],
                    false,
                )?;
                self.validation = Some(v.clone());
                if phase == "valid" {
                    Stage::Fingerprint
                } else {
                    stage
                }
            }
            Stage::Fingerprint => {
                let validation = self.validation.as_ref().ok_or_else(|| {
                    invalid("La validation doit être terminée avant le calcul d’intégrité.")
                })?;
                require(
                    v["validation_sha256"] == validation["validator_sha256"]
                        && v["fingerprint_version"] == 2
                        && v["fingerprint_contract_sha256"] == fingerprint_contract()?
                        && v["source_transfer_id"].as_str().is_some_and(uuid)
                        && (v["source_revision"] != 1
                            || v["source_transfer_id"] == m.bootstrap_transfer_id)
                        && matches!(
                            phase,
                            "pending" | "source" | "target" | "complete" | "stale"
                        )
                        && v["fingerprint_complete"] == (phase == "complete")
                        && v["business_validated"] == false,
                )?;
                number(v, "checked_rows")?;
                number(v, "checked_bytes")?;
                if phase == "complete" {
                    require(
                        hash(&v["source_state_sha256"])
                            && hash(&v["target_state_sha256"])
                            && v["target_rows"] == v["checked_rows"],
                    )?;
                    number(v, "source_rows")?;
                    number(v, "target_rows")?;
                } else {
                    require(v["target_state_sha256"].is_null())?;
                }
                if let Some(old) = &self.fingerprint {
                    require(old["source_transfer_id"] == v["source_transfer_id"])?;
                }
                // The target pass intentionally starts its counters at zero.
                Self::monotonic(
                    &self.fingerprint,
                    v,
                    phase_key,
                    &["checked_rows", "checked_bytes"],
                    true,
                )?;
                self.fingerprint = Some(v.clone());
                if phase == "complete" {
                    Stage::Delivery
                } else {
                    stage
                }
            }
            Stage::Delivery => {
                require(
                    matches!(phase, "preparing" | "prepared" | "stale")
                        && v["total_parts"] == m.chunks.len()
                        && number(v, "prepared_parts")? <= m.chunks.len() as u64,
                )?;
                if phase == "prepared" {
                    require(v["prepared_parts"] == v["total_parts"] && hash(&v["bundle_sha256"]))?;
                } else {
                    require(v["bundle_sha256"].is_null())?;
                }
                Self::monotonic(&self.delivery, v, phase_key, &["prepared_parts"], false)?;
                self.delivery = Some(v.clone());
                if phase == "prepared" {
                    Stage::Commit
                } else {
                    stage
                }
            }
            Stage::Commit => return Err(invalid("L’étape de contrôle est invalide.")),
        };
        Ok((next, stopped))
    }
    fn monotonic(
        old: &Option<Value>,
        v: &Value,
        phase: &str,
        keys: &[&str],
        same_phase_only: bool,
    ) -> AppResult<()> {
        if let Some(old) = old {
            if !same_phase_only || old[phase] == v[phase] {
                for key in keys {
                    require(number(v, key)? >= number(old, key)?)?;
                }
            }
        }
        Ok(())
    }
    fn commit(&self, v: &Value, p: &Prepared, manifest_hash: &str) -> AppResult<Value> {
        require(v["canonical_committed"] == true && v["replication_active"] == false)?;
        let receipt = verify_outgoing_receipt(
            &serde_json::to_vec(&v["receipt"])?,
            &p.manifest,
            manifest_hash,
        )?;
        let fingerprint = self
            .fingerprint
            .as_ref()
            .ok_or_else(|| invalid("La preuve d’intégrité est absente."))?;
        let delivery = self
            .delivery
            .as_ref()
            .ok_or_else(|| invalid("La préparation de réception est absente."))?;
        for key in [
            "source_transfer_id",
            "source_revision",
            "validation_sha256",
            "fingerprint_version",
            "fingerprint_contract_sha256",
            "source_state_sha256",
            "target_state_sha256",
        ] {
            require(receipt[key] == fingerprint[key])?;
        }
        require(receipt["bundle_sha256"] == delivery["bundle_sha256"])?;
        Ok(receipt)
    }
}
pub(super) fn committed_status(receipt: Value, requests: usize) -> Value {
    json!({"state":"committed", "transaction_id":receipt["transaction_id"], "revision":receipt["revision"],
        "receipt":receipt, "server_requests":requests, "canonical_committed":true,
        "acknowledged":false, "replication_active":false})
}
pub(super) async fn advance(
    store: &LocalStore,
    t: &impl Transport,
    p: &Prepared,
    budget: usize,
) -> AppResult<Value> {
    require((1..=8).contains(&budget))?;
    let manifest_hash = digest(&serde_json::to_vec(&p.manifest)?);
    let mut stage = Stage::Review;
    let mut first_review = true;
    let mut proofs = Proofs::default();
    let mut last = Value::Null;
    for request in 1..=budget {
        t.current(store)?;
        bound(store, p)?;
        let body = if stage == Stage::Review {
            Some(serde_json::to_vec(
                &json!({"action": if first_review { "prepare" } else { "advance" }}),
            )?)
        } else {
            None
        };
        first_review = false;
        let (code, bytes) = t
            .lifecycle_request(stage.path(), &p.manifest.transaction_id, body)
            .await?;
        // Check the account and local binding even if the response was an error.
        t.current(store)?;
        bound(store, p)?;
        let value = response(code, &bytes)?;
        if stage == Stage::Commit {
            return Ok(committed_status(
                proofs.commit(&value, p, &manifest_hash)?,
                request,
            ));
        }
        let (next, stopped) = proofs.check(stage, &value, p, &manifest_hash)?;
        let phase = value[if matches!(stage, Stage::Review | Stage::Delivery) {
            "state"
        } else {
            "phase"
        }]
        .clone();
        last = json!({"state":if stopped { phase.clone() } else { json!(stage.label()) }, "phase":phase,
            "transaction_id":p.manifest.transaction_id,"source_revision":value["source_revision"],
            "server_requests":request,"canonical_committed":false,"acknowledged":false,"replication_active":false});
        for key in [
            "copied_rows",
            "applied_changes",
            "checked_structural_rules",
            "total_structural_rules",
            "checked_accounting_rules",
            "total_accounting_rules",
            "checked_changes",
            "total_changes",
            "checked_rows",
            "checked_bytes",
            "prepared_parts",
            "total_parts",
            "failed_rule",
            "failed_change",
            "conflicts",
        ] {
            if let Some(field) = value.get(key) {
                last[key] = field.clone();
            }
        }
        if stopped {
            return Ok(last);
        }
        stage = next;
    }
    Ok(last)
}

#[cfg(test)]
mod tests;
