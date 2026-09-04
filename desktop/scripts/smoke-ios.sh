#!/usr/bin/env bash
set -euo pipefail
mkdir -p desktop/artifacts/ios
app_path="$(find "$HOME/Library/Developer/Xcode/DerivedData" -type d -path '*/debug-iphonesimulator/Zentra.app' -print -quit)"
test -n "$app_path"
simulator="$(xcrun simctl list devices available --json | node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>{const device=Object.values(JSON.parse(data).devices).flat().find(device=>device.name.startsWith("iPhone"));if(!device)process.exit(1);process.stdout.write(device.udid);});')"
xcrun simctl boot "$simulator" || true
xcrun simctl bootstatus "$simulator" -b
xcrun simctl install "$simulator" "$app_path"
xcrun simctl launch "$simulator" ch.zentra.mobile
sleep 8
profile="$(xcrun simctl get_app_container "$simulator" ch.zentra.mobile data)"
test -n "$(find "$profile" -name helvichantier.sqlite3 -print -quit)"
test -n "$(find "$profile" -name installation-identity.protected -print -quit)"
xcrun simctl io "$simulator" screenshot desktop/artifacts/ios/startup.png
xcrun simctl shutdown "$simulator"
echo 'iOS startup, SQLite and Keychain initialization verified.'
