#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Isolate the UIKit tests from the application linker. The real Tauri plugin is
# then compiled by the IPA workflow; this package exercises layout/hit-testing.
root=$(pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/zentra-navigation.XXXXXX")
mkdir -p "$test_root/Sources" "$test_root/Tests" desktop/artifacts/navigation
cp desktop/plugins/zentra-mobile/ios/Sources/GlassNavigation.swift "$test_root/Sources/"
cp desktop/plugins/zentra-mobile/ios/Sources/AppAppearance.swift "$test_root/Sources/"
cp desktop/plugins/zentra-mobile/ios/Tests/*.swift "$test_root/Tests/"
cat > "$test_root/Package.swift" <<'SWIFT'
// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "tauri-plugin-zentra-mobile", platforms: [.iOS(.v13)],
  products: [.library(name: "tauri-plugin-zentra-mobile", targets: ["tauri-plugin-zentra-mobile"])],
  targets: [.target(name: "tauri-plugin-zentra-mobile", path: "Sources"),
    .testTarget(name: "NavigationTests", dependencies: ["tauri-plugin-zentra-mobile"], path: "Tests")])
SWIFT
xcrun simctl list devices available -j > "$test_root/devices.json"
device=$(python3 - "$test_root/devices.json" <<'PY'
import json, sys
for runtime, devices in json.load(open(sys.argv[1]))['devices'].items():
    if 'iOS-26' in runtime:
        for device in devices:
            if device.get('isAvailable') and device['name'].startswith('iPhone'):
                print(device['udid'])
                sys.exit(0)
sys.exit('An iOS 26 simulator is required for the Liquid Glass tests')
PY
)
cd "$test_root"
xcodebuild test -scheme tauri-plugin-zentra-mobile -destination "platform=iOS Simulator,id=$device" \
  -resultBundlePath "$root/desktop/artifacts/navigation/LiquidGlass.xcresult" CODE_SIGNING_ALLOWED=NO \
  | tee "$root/desktop/artifacts/navigation/LiquidGlass.log"
