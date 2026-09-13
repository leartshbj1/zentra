use super::DocumentStyle;
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Template {
    version: u8,
    id: String,
    name: String,
    source_kind: String,
    style: DocumentStyle,
}

pub(super) fn validate(extra: &Value) -> AppResult<()> {
    let Some(value) = extra.get("documentDesignTemplates") else {
        return Ok(());
    };
    let templates = value.as_array().ok_or_else(|| {
        AppError::Validation("La liste de vos modèles de documents est invalide.".into())
    })?;
    if templates.len() > 20 {
        return Err(AppError::Validation("Vous pouvez conserver 20 modèles de documents. Retirez un modèle inutilisé avant d’en ajouter un.".into()));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for value in templates {
        let template: Template = serde_json::from_value(value.clone()).map_err(|_| AppError::Validation("Un modèle de document est incomplet ou incompatible. Retirez ce modèle puis recréez-le depuis une présentation valide.".into()))?;
        let id = uuid::Uuid::parse_str(&template.id).map_err(|_| {
            AppError::Validation("Un modèle de document a un identifiant invalide.".into())
        })?;
        if template.version != 1
            || !["quotes", "invoices", "accounts", "payslips"]
                .contains(&template.source_kind.as_str())
            || !ids.insert(id)
        {
            return Err(AppError::Validation(
                "Un modèle de document est incompatible ou présent plusieurs fois.".into(),
            ));
        }
        if template.name.trim().is_empty()
            || template.name != template.name.trim()
            || template.name.chars().count() > 60
            || template.name.chars().any(char::is_control)
            || !names.insert(template.name.to_lowercase())
        {
            return Err(AppError::Validation("Donnez à chaque modèle un nom différent, sur une seule ligne, de 60 caractères maximum.".into()));
        }
        template.style.validate().map_err(|reason| {
            AppError::Validation(format!("Modèle « {} » : {reason}", template.name))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::LocalStore;
    use serde_json::json;

    fn template() -> Value {
        json!({"version":1,"id":"713a3d9d-e8da-4ca8-9b56-b0e02d3b3da3","name":"Mon devis classique","sourceKind":"quotes",
            "style":{"accentColor":"#182b49","layout":"signature","logoWidth":120,"footer":"Contactez notre atelier",
                "composition":{"fontFamily":"times","logoPosition":"right","pageOrientation":"landscape","titleFontFamily":"helvetica","marginMm":21.5,
                    "closing":[{"runs":[{"text":"Conditions du modèle","bold":true,"fontFamily":"courier","fontSize":12}]}]}}})
    }

    #[test]
    fn document_templates_reject_malformed_libraries_and_invalid_designs() {
        assert!(validate(&json!({})).is_ok());
        assert!(validate(&json!({"documentDesignTemplates":[]})).is_ok());
        for value in [
            Value::Null,
            json!({}),
            json!("model"),
            json!([{}]),
            json!(vec![template(); 21]),
        ] {
            assert!(validate(&json!({"documentDesignTemplates":value})).is_err());
        }
        for (pointer, bad) in [
            ("/version", json!(2)),
            ("/id", json!("invalid")),
            ("/name", json!("")),
            ("/name", json!(" Leading")),
            ("/name", json!("Line\nTwo")),
            ("/name", json!("a".repeat(61))),
            ("/sourceKind", json!("bank")),
            ("/style/accentColor", json!("red")),
            ("/style/composition/fontFamily", json!("unknown")),
            ("/style/composition/marginMm", json!(400)),
            (
                "/style/composition/closing/0/runs/0/text",
                json!("Cannot print 🐈"),
            ),
        ] {
            let mut item = template();
            *item.pointer_mut(pointer).unwrap() = bad;
            assert!(
                validate(&json!({"documentDesignTemplates":[item]})).is_err(),
                "{pointer}"
            );
        }
        let first = template();
        let mut second = template();
        second["name"] = json!("Another model");
        assert!(validate(&json!({"documentDesignTemplates":[first,second]})).is_err());
        let first = template();
        let mut second = template();
        second["id"] = json!(uuid::Uuid::new_v4().to_string());
        second["name"] = json!("MON DEVIS CLASSIQUE");
        assert!(validate(&json!({"documentDesignTemplates":[first,second]})).is_err());
    }

    #[test]
    fn document_templates_settings_round_trip_and_refusal_are_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(dir.path().join("profile")).unwrap();
        store.connect().unwrap().execute("INSERT INTO settings(id,onboarding_completed,company_name,noga_section,noga_division,activity_description,created_at,updated_at) VALUES(1,1,'Atelier','F','43','Travaux spécialisés','2026-09-13T01:00:00Z','2026-09-13T01:00:00Z')",[]).unwrap();
        let library = json!([template()]);
        let saved = store
            .update_settings(json!({"extra_settings_json":{"documentDesignTemplates":library}}))
            .unwrap();
        let extra: Value =
            serde_json::from_str(saved["extra_settings_json"].as_str().unwrap()).unwrap();
        assert_eq!(extra["documentDesignTemplates"], library);
        let before: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT extra_settings_json FROM settings WHERE id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let mut invalid = extra.clone();
        invalid["documentDesignTemplates"][0]["style"]["accentColor"] = json!("broken");
        assert!(store
            .update_settings(json!({"company_name":"Name rejected","extra_settings_json":invalid}))
            .is_err());
        let (after, name): (String, String) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT extra_settings_json,company_name FROM settings WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(after, before);
        assert_eq!(name, "Atelier");
        // Stored templates can be rendered in every supported category after retrieval.
        for kind in ["invoices", "quotes", "accounts", "payslips"] {
            let bytes = store
                .document_design_example(
                    kind,
                    extra["documentDesignTemplates"][0]["style"].clone(),
                    json!({"company_name":"Atelier"}),
                )
                .unwrap();
            let pdf = lopdf::Document::load_mem(&bytes).unwrap();
            assert!(!pdf.get_pages().is_empty());
            let text = pdf
                .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
                .unwrap();
            assert!(text.contains("Conditions du modèle"));
            assert!(!text.contains("Mon devis classique"));
        }
    }
}
