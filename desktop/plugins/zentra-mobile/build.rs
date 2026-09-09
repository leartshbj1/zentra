fn main() {
    tauri_plugin::Builder::new(&["configure_navigation"])
        .android_path("android")
        .ios_path("ios")
        .build();
}
