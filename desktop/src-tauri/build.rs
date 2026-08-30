use std::{env, fs};

const LICENSE_PUBLIC_KEY_ENV: &str = "HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL";
const LICENSE_PUBLIC_KEY_FILE: &str = "license-public-key.b64url";

fn main() {
    println!("cargo:rerun-if-changed={LICENSE_PUBLIC_KEY_FILE}");

    // The desktop executable links this crate as an rlib; the cdylib is kept only
    // for Tauri's cross-platform crate layout and is not an FFI surface. MinGW's
    // linker otherwise auto-exports the complete Rust dependency graph and can
    // exceed the PE export-ordinal limit while running `cargo test --all-targets`.
    let windows_gnu = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu");
    if windows_gnu {
        println!("cargo:rustc-cdylib-link-arg=-Wl,--exclude-all-symbols");
    }

    if env::var("PROFILE").as_deref() == Ok("release") {
        let public_key = load_release_public_key();
        println!("cargo:rustc-env={LICENSE_PUBLIC_KEY_ENV}={public_key}");
    }
    if windows_gnu {
        // Tauri normally attaches its Windows manifest only to application
        // binaries. A Rust library unit-test harness is also an executable, so
        // MinGW must receive the Common Controls v6 manifest for every linked
        // artifact; otherwise TaskDialogIndirect fails before tests can start.
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("Échec du build Tauri Windows GNU");
        embed_resource::compile_for_everything(
            "windows-common-controls-v6.rc",
            embed_resource::NONE,
        )
        .manifest_required()
        .expect("Échec de compilation du manifeste Windows GNU");
    } else {
        tauri_build::build();
    }
}

fn load_release_public_key() -> String {
    let public_key = fs::read_to_string(LICENSE_PUBLIC_KEY_FILE)
        .unwrap_or_else(|error| {
            panic!("Build release refusé : impossible de lire {LICENSE_PUBLIC_KEY_FILE}: {error}")
        })
        .trim()
        .to_owned();

    // An Ed25519 public key is exactly 32 bytes, represented by 43 canonical
    // base64url characters without padding. For this length, the final two
    // encoded bits must be zero (the final alphabet index is a multiple of 4).
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let last_index = public_key
        .as_bytes()
        .last()
        .and_then(|last| alphabet.iter().position(|candidate| candidate == last));
    let valid = public_key.len() == 43
        && public_key.bytes().all(|byte| alphabet.contains(&byte))
        && last_index.is_some_and(|index| index % 4 == 0);

    assert!(
        valid,
        "Build release refusé : {LICENSE_PUBLIC_KEY_FILE} doit contenir une clé publique Ed25519 canonique (32 octets en base64url sans padding)."
    );
    public_key
}
