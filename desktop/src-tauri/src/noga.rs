use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

pub const NOGA_VERSION: &str = "NOGA 2025";
pub const NOGA_SOURCE: &str = "https://www.kubb-tool.bfs.admin.ch/fr/noga/2025";

#[derive(Debug, Clone, Copy)]
struct Division {
    code: &'static str,
    label: &'static str,
}

#[derive(Debug, Clone, Copy)]
struct Section {
    code: &'static str,
    label: &'static str,
    divisions: &'static [Division],
}

macro_rules! divisions {
    ($(($code:literal, $label:literal)),+ $(,)?) => {
        &[$(Division { code: $code, label: $label }),+]
    };
}

const SECTIONS: &[Section] = &[
    Section { code: "A", label: "Agriculture, sylviculture et pêche", divisions: divisions![
        ("01", "Culture et production animale, chasse et services annexes"),
        ("02", "Sylviculture et exploitation forestière"),
        ("03", "Pêche et aquaculture"),
    ]},
    Section { code: "B", label: "Industries extractives", divisions: divisions![
        ("05", "Extraction de houille et de lignite"),
        ("06", "Extraction d’hydrocarbures"),
        ("07", "Extraction de minerais métalliques"),
        ("08", "Autres industries extractives"),
        ("09", "Activités de soutien aux industries extractives"),
    ]},
    Section { code: "C", label: "Industrie manufacturière", divisions: divisions![
        ("10", "Industries alimentaires"),
        ("11", "Fabrication de boissons"),
        ("12", "Fabrication de produits à base de tabac"),
        ("13", "Fabrication de textiles"),
        ("14", "Industrie de l’habillement"),
        ("15", "Fabrication de cuir, d’articles en cuir et de produits similaires dans d’autres matières"),
        ("16", "Travail du bois et fabrication d’articles en bois et en liège, à l’exception des meubles; fabrication d’articles en vannerie et sparterie"),
        ("17", "Industrie du papier et du carton"),
        ("18", "Imprimerie et reproduction d’enregistrements"),
        ("19", "Cokéfaction et raffinage"),
        ("20", "Industrie chimique"),
        ("21", "Industrie pharmaceutique"),
        ("22", "Fabrication de produits en caoutchouc et en plastique"),
        ("23", "Fabrication d’autres produits minéraux non métalliques"),
        ("24", "Métallurgie"),
        ("25", "Fabrication de produits métalliques, à l’exception des machines et des équipements"),
        ("26", "Fabrication de produits informatiques, électroniques et optiques"),
        ("27", "Fabrication d’équipements électriques"),
        ("28", "Fabrication de machines et équipements n.c.a."),
        ("29", "Industrie automobile"),
        ("30", "Fabrication d’autres matériels de transport"),
        ("31", "Fabrication de meubles"),
        ("32", "Autres industries manufacturières"),
        ("33", "Réparation, entretien et installation de machines et d’équipements"),
    ]},
    Section { code: "D", label: "Production et distribution d’électricité, de gaz, de vapeur et d’air conditionné", divisions: divisions![
        ("35", "Production et distribution d’électricité, de gaz, de vapeur et d’air conditionné"),
    ]},
    Section { code: "E", label: "Production et distribution d’eau; assainissement, gestion des déchets et dépollution", divisions: divisions![
        ("36", "Captage, traitement et distribution d’eau"),
        ("37", "Collecte et traitement des eaux usées"),
        ("38", "Collecte, valorisation et élimination des déchets"),
        ("39", "Activités de dépollution et autres activités de service de gestion des déchets"),
    ]},
    Section { code: "F", label: "Construction", divisions: divisions![
        ("41", "Construction de bâtiments résidentiels et non résidentiels"),
        ("42", "Génie civil"),
        ("43", "Travaux de construction spécialisés"),
    ]},
    Section { code: "G", label: "Commerce", divisions: divisions![
        ("46", "Commerce de gros"),
        ("47", "Commerce de détail"),
    ]},
    Section { code: "H", label: "Transports et entreposage", divisions: divisions![
        ("49", "Transports terrestres et transports par conduites"),
        ("50", "Transport par eau"),
        ("51", "Transports aériens"),
        ("52", "Entreposage et services auxiliaires des transports"),
        ("53", "Activités de poste et de courrier"),
    ]},
    Section { code: "I", label: "Hébergement et restauration", divisions: divisions![
        ("55", "Hébergement"),
        ("56", "Activités de service de restauration"),
    ]},
    Section { code: "J", label: "Édition, diffusion et activités de production et de distribution de contenu", divisions: divisions![
        ("58", "Activités d’édition"),
        ("59", "Production de films cinématographiques, de vidéos et de programmes de télévision; enregistrement sonore et édition musicale"),
        ("60", "Activités de programmation, de diffusion, d’agence de presse et autres activités de distribution de contenu"),
    ]},
    Section { code: "K", label: "Télécommunications, programmation informatique, conseil, infrastructure informatique et autres activités de service d’information", divisions: divisions![
        ("61", "Télécommunications"),
        ("62", "Programmation, conseil et autres activités informatiques"),
        ("63", "Infrastructure informatique, traitement de données et autres activités de service d’information"),
    ]},
    Section { code: "L", label: "Activités financières et d’assurance", divisions: divisions![
        ("64", "Activités de services financiers, hors assurance et fonds de pension"),
        ("65", "Assurance, réassurance et fonds de pension, à l’exclusion de la sécurité sociale obligatoire"),
        ("66", "Activités auxiliaires d’activités de services financiers et d’assurance"),
    ]},
    Section { code: "M", label: "Activités immobilières", divisions: divisions![
        ("68", "Activités immobilières"),
    ]},
    Section { code: "N", label: "Activités spécialisées, scientifiques et techniques", divisions: divisions![
        ("69", "Activités juridiques et comptables"),
        ("70", "Activités des sièges sociaux et conseil de gestion"),
        ("71", "Activités d’architecture et d’ingénierie; activités de contrôle et analyses techniques"),
        ("72", "Recherche et développement scientifique"),
        ("73", "Activités de publicité, d’études de marché et de relations publiques"),
        ("74", "Autres activités spécialisées, scientifiques et techniques"),
        ("75", "Activités vétérinaires"),
    ]},
    Section { code: "O", label: "Activités de service administratif et de soutien", divisions: divisions![
        ("77", "Activités de location et location-bail"),
        ("78", "Activités liées à l’emploi"),
        ("79", "Activités d’agence de voyage, de voyagiste, de service de réservation et de services connexes"),
        ("80", "Activités d’investigation et de sécurité"),
        ("81", "Activités de services pour les bâtiments et l’aménagement paysager"),
        ("82", "Activités de service de bureau, de soutien administratif et d’autre soutien aux entreprises"),
    ]},
    Section { code: "P", label: "Administration publique et défense; sécurité sociale obligatoire", divisions: divisions![
        ("84", "Administration publique et défense; sécurité sociale obligatoire"),
    ]},
    Section { code: "Q", label: "Enseignement", divisions: divisions![
        ("85", "Enseignement"),
    ]},
    Section { code: "R", label: "Santé humaine et activités d’action sociale", divisions: divisions![
        ("86", "Activités pour la santé humaine"),
        ("87", "Activités de soins en établissement résidentiel"),
        ("88", "Activités d’action sociale sans hébergement"),
    ]},
    Section { code: "S", label: "Arts, sports et activités récréatives", divisions: divisions![
        ("90", "Activités de création artistique et de spectacle"),
        ("91", "Bibliothèques, archives, musées et autres activités culturelles"),
        ("92", "Activités de jeux d’argent et de paris"),
        ("93", "Activités sportives et activités récréatives et de loisirs"),
    ]},
    Section { code: "T", label: "Autres activités de services", divisions: divisions![
        ("94", "Activités des organisations associatives"),
        ("95", "Réparation et entretien d’ordinateurs, de biens personnels et domestiques et d’automobiles et motocycles"),
        ("96", "Activités de services aux personnes"),
    ]},
    Section { code: "U", label: "Activités des ménages en tant qu’employeurs; activités indifférenciées des ménages en tant que producteurs de biens et services pour usage propre", divisions: divisions![
        ("97", "Activités des ménages en tant qu’employeurs de personnel domestique"),
        ("98", "Activités indifférenciées des ménages en tant que producteurs de biens et services pour usage propre"),
    ]},
    Section { code: "V", label: "Activités des organisations et organismes extraterritoriaux", divisions: divisions![
        ("99", "Activités des organisations et organismes extraterritoriaux"),
    ]},
];

pub fn catalog_json() -> Value {
    let sections = SECTIONS
        .iter()
        .map(|section| {
            let divisions = section
                .divisions
                .iter()
                .map(|division| json!({"code":division.code,"label":division.label}))
                .collect::<Vec<_>>();
            json!({"code":section.code,"label":section.label,"divisions":divisions})
        })
        .collect::<Vec<_>>();
    json!({"version":NOGA_VERSION,"source":NOGA_SOURCE,"sections":sections})
}

pub fn validate_activity_profile(
    section_code: &str,
    division_code: &str,
    activity_description: &str,
    detailed_code: Option<&str>,
) -> AppResult<()> {
    let section = SECTIONS
        .iter()
        .find(|section| section.code == section_code)
        .ok_or_else(|| {
            AppError::Validation("noga_section doit être une section NOGA 2025 de A à V.".into())
        })?;
    if division_code.len() != 2 || !division_code.bytes().all(|value| value.is_ascii_digit()) {
        return Err(AppError::Validation(
            "noga_division doit contenir exactement deux chiffres.".into(),
        ));
    }
    if !section
        .divisions
        .iter()
        .any(|division| division.code == division_code)
    {
        return Err(AppError::Validation(format!(
            "La division NOGA {division_code} n'appartient pas à la section {section_code}."
        )));
    }
    let description = activity_description.trim();
    if description.is_empty() || description.chars().count() > 2_000 {
        return Err(AppError::Validation(
            "activity_description est obligatoire et limitée à 2000 caractères.".into(),
        ));
    }
    if let Some(code) = detailed_code.map(str::trim).filter(|code| !code.is_empty()) {
        if !matches!(code.len(), 3 | 4 | 6)
            || !code.bytes().all(|value| value.is_ascii_digit())
            || !code.starts_with(division_code)
        {
            return Err(AppError::Validation(
                "noga_detailed_code doit contenir 3, 4 ou 6 chiffres et commencer par la division NOGA sélectionnée."
                    .into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_catalog_contains_22_sections_and_87_divisions() {
        assert_eq!(SECTIONS.len(), 22);
        assert_eq!(
            SECTIONS
                .iter()
                .map(|section| section.divisions.len())
                .sum::<usize>(),
            87
        );
        assert!(
            validate_activity_profile("F", "43", "Travaux du bâtiment", Some("432100")).is_ok()
        );
        assert!(validate_activity_profile("F", "62", "Incompatible", None).is_err());
    }
}
