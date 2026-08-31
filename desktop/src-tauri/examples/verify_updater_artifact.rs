use std::{env, fs, process::ExitCode};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn main() -> ExitCode {
    match verify_from_arguments() {
        Ok(()) => {
            println!("Signature Tauri/Ed25519 valide pour l’artefact de mise à jour.");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Validation de release refusée : {error}");
            ExitCode::FAILURE
        }
    }
}

fn verify_from_arguments() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let artifact_path = arguments
        .next()
        .ok_or_else(|| "chemin de l’installateur manquant".to_owned())?;
    let signature_path = arguments
        .next()
        .ok_or_else(|| "chemin du fichier .sig manquant".to_owned())?;
    if arguments.next().is_some() {
        return Err("arguments inattendus".to_owned());
    }

    let encoded_public_key = env::var("ELYKO_UPDATER_PUBLIC_KEY")
        .map_err(|_| "ELYKO_UPDATER_PUBLIC_KEY manque dans l’environnement".to_owned())?;
    let public_key_document = decode_document(&encoded_public_key, "clé publique")?;
    let public_key = PublicKey::decode(&public_key_document)
        .map_err(|error| format!("clé publique invalide : {error}"))?;

    let encoded_signature = fs::read_to_string(&signature_path)
        .map_err(|error| format!("lecture de la signature impossible : {error}"))?;
    let signature_document = decode_document(encoded_signature.trim(), "signature")?;
    let signature = Signature::decode(&signature_document)
        .map_err(|error| format!("signature Minisign invalide : {error}"))?;
    let artifact = fs::read(&artifact_path)
        .map_err(|error| format!("lecture de l’installateur impossible : {error}"))?;

    public_key
        .verify(&artifact, &signature, true)
        .map_err(|error| format!("signature non conforme à l’installateur : {error}"))
}

fn decode_document(value: &str, label: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| format!("{label} non encodée en base64 standard"))?;
    String::from_utf8(bytes).map_err(|_| format!("{label} non UTF-8"))
}
