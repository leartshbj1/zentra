// swift-tools-version:5.3
import PackageDescription
let package = Package(
  name: "tauri-plugin-zentra-mobile",
  platforms: [.iOS(.v13)],
  products: [.library(name: "tauri-plugin-zentra-mobile", type: .static, targets: ["tauri-plugin-zentra-mobile"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-zentra-mobile", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
