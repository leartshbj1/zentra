//! Updater configuration checks without a runtime, plugin or HTTP client.

use serde_json::Value;
use tauri::utils::config::PluginConfig;
use tauri_plugin_updater::Config as UpdaterConfig;

const BASE_CONFIG: &str = include_str!("../tauri.conf.json");
const RELEASE_CONFIG: &str = include_str!("../tauri.updater.conf.json");
const BUILD_PUBLIC_KEY_MARKER: &str = "INJECTED_BY_ELYKO_UPDATER_PUBLIC_KEY_AT_BUILD_TIME";

fn raw_updater_config(plugins: &PluginConfig) -> Value {
    // Tauri's plugin loader uses this extraction before applying Builder::pubkey.
    plugins.0.get("updater").cloned().unwrap_or_default()
}

fn assert_no_configured_network_or_tls_bypass(config: &UpdaterConfig) {
    // The validated, immutable build values remain responsible for admission
    // and for the request endpoint; the base and release JSON are inert here.
    assert_eq!(config.pubkey, BUILD_PUBLIC_KEY_MARKER);
    assert!(config.endpoints.is_empty());
    assert!(!config.dangerous_insecure_transport_protocol);
    assert!(!config.dangerous_accept_invalid_certs);
    assert!(!config.dangerous_accept_invalid_hostnames);
}

#[test]
fn base_config_deserializes_updater_before_the_build_key_override() {
    let config: tauri::Config = serde_json::from_str(BASE_CONFIG).expect("valid base Tauri config");
    let updater: UpdaterConfig = serde_json::from_value(raw_updater_config(&config.plugins))
        .expect("base updater config must deserialize before Builder::pubkey runs");

    assert_no_configured_network_or_tls_bypass(&updater);
}

#[test]
fn release_config_keeps_the_updater_inert_and_windows_install_mode_passive() {
    // This file is an overlay, so it does not contain all required root fields
    // of tauri::Config. Deserialize its real plugin map using Tauri's type.
    let config: Value = serde_json::from_str(RELEASE_CONFIG).expect("valid release Tauri overlay");
    let plugins: PluginConfig =
        serde_json::from_value(config.get("plugins").cloned().expect("release plugin map"))
            .expect("valid release Tauri plugin map");
    let updater: UpdaterConfig = serde_json::from_value(raw_updater_config(&plugins))
        .expect("release updater config must deserialize before Builder::pubkey runs");

    assert_no_configured_network_or_tls_bypass(&updater);
    assert_eq!(
        updater
            .windows
            .as_ref()
            .map(|windows| windows.install_mode.to_string())
            .as_deref(),
        Some("passive")
    );
}

#[test]
fn absent_updater_entry_reaches_the_vendor_deserializer_as_null() {
    let mut config: tauri::Config =
        serde_json::from_str(BASE_CONFIG).expect("valid base Tauri config");
    // Remove only the updater entry from the real parsed configuration. This
    // reproduces the old admission failure without a copied JSON fixture.
    config.plugins.0.remove("updater");
    let raw = raw_updater_config(&config.plugins);

    assert!(raw.is_null());
    assert!(serde_json::from_value::<UpdaterConfig>(raw).is_err());
}
