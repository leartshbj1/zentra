//! Plan comptable PME suisse (structure du plan comptable général KMU/PME,
//! classes 1 à 8). L'installation complète seulement : un numéro déjà
//! présent n'est jamais renommé, reclassé ni supprimé, qu'il soit utilisé
//! ou non.

use std::collections::HashSet;

use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::append_audit,
    database::{now_iso, query_all, LocalStore},
    error::{command_error, AppResult},
};

/// (numéro, nom, type, solde normal, rubrique du bilan ou du compte de résultat)
pub(crate) const SWISS_SME_CHART: &[(&str, &str, &str, &str, &str)] = &[
    // 1 Actifs — actifs circulants
    ("1000", "Caisse", "asset", "debit", "current_assets"),
    ("1020", "Banque", "asset", "debit", "current_assets"),
    ("1060", "Titres", "asset", "debit", "current_assets"),
    ("1100", "Créances résultant de livraisons et prestations", "asset", "debit", "current_assets"),
    ("1109", "Ducroire", "asset", "credit", "current_assets"),
    ("1140", "Avances et prêts", "asset", "debit", "current_assets"),
    ("1170", "Impôt préalable TVA : matériel, marchandises, prestations, énergie", "asset", "debit", "current_assets"),
    ("1171", "Impôt préalable TVA : investissements, autres charges", "asset", "debit", "current_assets"),
    ("1176", "Impôt anticipé à récupérer", "asset", "debit", "current_assets"),
    ("1180", "Créances envers les assurances sociales", "asset", "debit", "current_assets"),
    ("1190", "Autres créances à court terme", "asset", "debit", "current_assets"),
    ("1200", "Marchandises commerciales", "asset", "debit", "current_assets"),
    ("1210", "Matières premières", "asset", "debit", "current_assets"),
    ("1260", "Produits finis", "asset", "debit", "current_assets"),
    ("1280", "Travaux en cours", "asset", "debit", "current_assets"),
    ("1300", "Charges payées d'avance", "asset", "debit", "current_assets"),
    ("1301", "Produits à recevoir", "asset", "debit", "current_assets"),
    // 1 Actifs — actifs immobilisés
    ("1400", "Titres à long terme", "asset", "debit", "fixed_assets"),
    ("1440", "Prêts à long terme", "asset", "debit", "fixed_assets"),
    ("1480", "Participations", "asset", "debit", "fixed_assets"),
    ("1500", "Machines et appareils", "asset", "debit", "fixed_assets"),
    ("1509", "Correction de valeur des machines et appareils", "asset", "credit", "fixed_assets"),
    ("1510", "Mobilier et installations", "asset", "debit", "fixed_assets"),
    ("1520", "Machines de bureau, informatique et communication", "asset", "debit", "fixed_assets"),
    ("1530", "Véhicules", "asset", "debit", "fixed_assets"),
    ("1540", "Outillage et appareils", "asset", "debit", "fixed_assets"),
    ("1600", "Immeubles d'exploitation", "asset", "debit", "fixed_assets"),
    ("1700", "Brevets, licences et logiciels", "asset", "debit", "fixed_assets"),
    ("1770", "Goodwill", "asset", "debit", "fixed_assets"),
    // 2 Passifs — dettes à court terme
    ("2000", "Dettes résultant d'achats et de prestations", "liability", "credit", "short_term_liabilities"),
    ("2030", "Acomptes de clients", "liability", "credit", "short_term_liabilities"),
    ("2100", "Dettes bancaires à court terme", "liability", "credit", "short_term_liabilities"),
    ("2140", "Autres dettes financières à court terme", "liability", "credit", "short_term_liabilities"),
    ("2200", "TVA due", "liability", "credit", "short_term_liabilities"),
    ("2201", "Décompte TVA", "liability", "credit", "short_term_liabilities"),
    ("2206", "Impôt anticipé dû", "liability", "credit", "short_term_liabilities"),
    ("2208", "Impôts directs dus", "liability", "credit", "short_term_liabilities"),
    ("2210", "Autres dettes à court terme", "liability", "credit", "short_term_liabilities"),
    ("2261", "Dividendes à payer", "liability", "credit", "short_term_liabilities"),
    ("2270", "Assurances sociales et institutions de prévoyance", "liability", "credit", "short_term_liabilities"),
    ("2279", "Impôt à la source dû", "liability", "credit", "short_term_liabilities"),
    ("2300", "Charges à payer", "liability", "credit", "short_term_liabilities"),
    ("2301", "Produits encaissés d'avance", "liability", "credit", "short_term_liabilities"),
    ("2330", "Provisions à court terme", "liability", "credit", "short_term_liabilities"),
    // 2 Passifs — dettes à long terme
    ("2400", "Dettes bancaires à long terme", "liability", "credit", "long_term_liabilities"),
    ("2450", "Emprunts", "liability", "credit", "long_term_liabilities"),
    ("2500", "Autres dettes à long terme", "liability", "credit", "long_term_liabilities"),
    ("2600", "Provisions à long terme", "liability", "credit", "long_term_liabilities"),
    // 2 Passifs — fonds propres
    ("2800", "Capital propre ou capital social", "equity", "credit", "equity"),
    ("2850", "Compte privé", "equity", "debit", "equity"),
    ("2900", "Réserves légales issues du capital", "equity", "credit", "equity"),
    ("2950", "Réserves légales issues du bénéfice", "equity", "credit", "equity"),
    ("2960", "Réserves libres", "equity", "credit", "equity"),
    ("2970", "Bénéfice ou perte reporté", "equity", "credit", "equity"),
    ("2979", "Bénéfice ou perte de l'exercice", "equity", "credit", "equity"),
    // 3 Produits d'exploitation
    ("3000", "Ventes de produits fabriqués", "revenue", "credit", "net_revenue"),
    ("3200", "Ventes de marchandises", "revenue", "credit", "net_revenue"),
    ("3400", "Ventes de prestations de services", "revenue", "credit", "net_revenue"),
    ("3600", "Autres ventes et prestations", "revenue", "credit", "net_revenue"),
    ("3700", "Prestations propres", "revenue", "credit", "net_revenue"),
    ("3800", "Déductions sur ventes", "revenue", "debit", "net_revenue"),
    ("3805", "Pertes sur créances", "revenue", "debit", "net_revenue"),
    ("3900", "Variation des stocks de produits finis et en cours", "revenue", "credit", "net_revenue"),
    // 4 Charges de matériel, marchandises et prestations de tiers
    ("4000", "Charges de matériel", "expense", "debit", "cost_of_goods"),
    ("4200", "Achats de marchandises", "expense", "debit", "cost_of_goods"),
    ("4400", "Prestations et travaux de tiers", "expense", "debit", "cost_of_goods"),
    ("4500", "Énergie pour la production", "expense", "debit", "cost_of_goods"),
    ("4900", "Déductions obtenues sur achats", "expense", "credit", "cost_of_goods"),
    // 5 Charges de personnel
    ("5000", "Salaires", "expense", "debit", "personnel_expense"),
    ("5700", "Charges sociales AVS, AI, APG, AC", "expense", "debit", "personnel_expense"),
    ("5720", "Prévoyance professionnelle", "expense", "debit", "personnel_expense"),
    ("5730", "Assurance-accidents", "expense", "debit", "personnel_expense"),
    ("5740", "Assurance indemnités journalières maladie", "expense", "debit", "personnel_expense"),
    ("5800", "Autres charges de personnel", "expense", "debit", "personnel_expense"),
    ("5810", "Formation et perfectionnement", "expense", "debit", "personnel_expense"),
    ("5820", "Frais de déplacement", "expense", "debit", "personnel_expense"),
    ("5900", "Personnel temporaire", "expense", "debit", "personnel_expense"),
    // 6 Autres charges d'exploitation, amortissements, résultat financier
    ("6000", "Charges de locaux", "expense", "debit", "other_operating_expense"),
    ("6100", "Entretien, réparations et remplacement", "expense", "debit", "other_operating_expense"),
    ("6105", "Leasing d'immobilisations corporelles", "expense", "debit", "other_operating_expense"),
    ("6200", "Charges de véhicules et de transport", "expense", "debit", "other_operating_expense"),
    ("6260", "Leasing de véhicules", "expense", "debit", "other_operating_expense"),
    ("6300", "Assurances, droits, taxes et autorisations", "expense", "debit", "other_operating_expense"),
    ("6400", "Énergie et évacuation des déchets", "expense", "debit", "other_operating_expense"),
    ("6500", "Charges d'administration", "expense", "debit", "other_operating_expense"),
    ("6510", "Téléphone et internet", "expense", "debit", "other_operating_expense"),
    ("6513", "Frais de port", "expense", "debit", "other_operating_expense"),
    ("6530", "Fiduciaire et conseil", "expense", "debit", "other_operating_expense"),
    ("6570", "Informatique et logiciels", "expense", "debit", "other_operating_expense"),
    ("6600", "Publicité", "expense", "debit", "other_operating_expense"),
    ("6700", "Autres charges d'exploitation", "expense", "debit", "other_operating_expense"),
    ("6800", "Amortissements", "expense", "debit", "depreciation"),
    ("6900", "Charges financières", "expense", "debit", "financial_result"),
    ("6940", "Frais bancaires", "expense", "debit", "financial_result"),
    ("6950", "Produits financiers", "revenue", "credit", "financial_result"),
    // 7 Résultats des activités annexes
    ("7000", "Produits accessoires", "revenue", "credit", "non_operating_result"),
    ("7010", "Charges accessoires", "expense", "debit", "non_operating_result"),
    ("7500", "Produits des immeubles d'exploitation", "revenue", "credit", "non_operating_result"),
    ("7510", "Charges des immeubles d'exploitation", "expense", "debit", "non_operating_result"),
    // 8 Résultats hors exploitation, exceptionnels et impôts
    ("8000", "Charges hors exploitation", "expense", "debit", "non_operating_result"),
    ("8100", "Produits hors exploitation", "revenue", "credit", "non_operating_result"),
    ("8500", "Charges exceptionnelles ou hors période", "expense", "debit", "exceptional_result"),
    ("8510", "Produits exceptionnels ou hors période", "revenue", "credit", "exceptional_result"),
    ("8900", "Impôts directs", "expense", "debit", "taxes"),
];

fn existing_codes(connection: &rusqlite::Connection) -> AppResult<HashSet<String>> {
    let mut statement = connection.prepare("SELECT code FROM accounts")?;
    let codes = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(codes)
}

fn missing_accounts(codes: &HashSet<String>) -> Vec<&'static (&'static str, &'static str, &'static str, &'static str, &'static str)> {
    SWISS_SME_CHART.iter().filter(|(code, ..)| !codes.contains(*code)).collect()
}

impl LocalStore {
    /// Comptes du plan PME absents de cette entreprise, sans rien écrire.
    pub fn swiss_sme_chart_preview(&self) -> AppResult<Value> {
        let connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let codes = existing_codes(&connection)?;
        let missing = missing_accounts(&codes)
            .into_iter()
            .map(|(code, name, account_type, _, report_section)| json!({"code": code, "name": name, "account_type": account_type, "report_section": report_section}))
            .collect::<Vec<_>>();
        Ok(json!({"total": SWISS_SME_CHART.len(), "present": SWISS_SME_CHART.len() - missing.len(), "missing": missing}))
    }

    /// Ajoute seulement les comptes manquants. Rien n'est renommé ni supprimé.
    pub fn complete_swiss_sme_chart(&self) -> AppResult<Value> {
        let mut connection = self.connect()?;
        self.require_onboarding(&connection)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let codes = existing_codes(&tx)?;
        let missing = missing_accounts(&codes);
        let now = now_iso();
        let mut added = Vec::with_capacity(missing.len());
        for (code, name, account_type, normal_balance, report_section) in missing {
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
                params![id, code, name, account_type, normal_balance, report_section, now, now],
            )?;
            added.push(*code);
        }
        let result = json!({"added": added, "kept": codes.len()});
        if !added.is_empty() {
            append_audit(&tx, "install", "swiss_sme_chart", "1", &result)?;
        }
        let accounts = query_all(&tx, "SELECT * FROM accounts ORDER BY code,name", [])?;
        tx.commit()?;
        Ok(json!({"added": added.len(), "kept": codes.len(), "accounts": accounts}))
    }
}

#[tauri::command]
pub fn swiss_sme_chart_preview(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.swiss_sme_chart_preview().map_err(command_error)
}

#[tauri::command]
pub fn complete_swiss_sme_chart(state: tauri::State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.require_write_access().map_err(command_error)?;
    state.complete_swiss_sme_chart().map_err(command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECTIONS: &[&str] = &[
        "current_assets", "fixed_assets", "short_term_liabilities", "long_term_liabilities", "equity", "net_revenue", "cost_of_goods",
        "personnel_expense", "other_operating_expense", "depreciation", "financial_result", "non_operating_result", "exceptional_result", "taxes",
    ];

    #[test]
    fn chart_codes_are_unique_ordered_and_classified() {
        let mut seen = HashSet::new();
        let mut previous = "";
        for (code, name, account_type, normal_balance, section) in SWISS_SME_CHART {
            assert!(seen.insert(*code), "duplicate {code}");
            assert!(*code > previous, "{code} out of order");
            previous = *code;
            assert_eq!(code.len(), 4);
            assert!(!name.trim().is_empty());
            assert!(SECTIONS.contains(section), "{code} {section}");
            assert!(matches!(*normal_balance, "debit" | "credit"));
            // La classe du numéro suit la nature du compte.
            let class = &code[..1];
            match *account_type {
                "asset" => assert_eq!(class, "1"),
                "liability" | "equity" => assert_eq!(class, "2"),
                "revenue" => assert!(matches!(class, "3" | "6" | "7" | "8"), "{code}"),
                "expense" => assert!(matches!(class, "4" | "5" | "6" | "7" | "8"), "{code}"),
                other => panic!("type {other}"),
            }
            if *account_type == "equity" {
                assert!(code.starts_with("28") || code.starts_with("29"));
            }
        }
        assert!(SWISS_SME_CHART.len() >= 100);
    }

    #[test]
    fn completion_adds_missing_accounts_and_never_touches_existing_ones() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        store.complete_onboarding(crate::tests::test_onboarding(), "swiss-sme-chart-test").unwrap();
        store.install_swiss_accounting_starter().unwrap();
        let before = store.connect().unwrap().query_row("SELECT name FROM accounts WHERE code='2000'", [], |row| row.get::<_, String>(0)).unwrap();
        let preview = store.swiss_sme_chart_preview().unwrap();
        let missing = preview["missing"].as_array().unwrap().len();
        assert!(missing > 80);
        assert!(preview["missing"].as_array().unwrap().iter().all(|row| row["code"] != "2000" && row["code"] != "1020"));
        let result = store.complete_swiss_sme_chart().unwrap();
        assert_eq!(result["added"], missing);
        let connection = store.connect().unwrap();
        // L'ancien compte 2000 garde son nom : il peut déjà porter des écritures.
        let after = connection.query_row("SELECT name FROM accounts WHERE code='2000'", [], |row| row.get::<_, String>(0)).unwrap();
        assert_eq!(after, before);
        let total: i64 = connection.query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0)).unwrap();
        assert!(total as usize >= SWISS_SME_CHART.len());
        drop(connection);
        // Une seconde fois : rien à ajouter.
        assert_eq!(store.complete_swiss_sme_chart().unwrap()["added"], 0);
        assert_eq!(store.swiss_sme_chart_preview().unwrap()["missing"].as_array().unwrap().len(), 0);
    }
}
