#!/usr/bin/env bash
set -euo pipefail
# The availability check at runtime still supports iOS 15–18; compilation needs SDK 26.
for candidate in /Applications/Xcode*.app; do
  sdk=$(DEVELOPER_DIR="$candidate/Contents/Developer" xcrun --sdk iphoneos --show-sdk-version 2>/dev/null || true)
  if [[ "${sdk%%.*}" =~ ^[0-9]+$ ]] && (( ${sdk%%.*} >= 26 )); then
    export DEVELOPER_DIR="$candidate/Contents/Developer"
    if [[ -n "${GITHUB_ENV:-}" ]]; then echo "DEVELOPER_DIR=$DEVELOPER_DIR" >> "$GITHUB_ENV"; fi
    xcodebuild -version
    exit 0
  fi
done
echo "Xcode with iOS SDK 26 or newer is required for Apple's native Liquid Glass controls." >&2
exit 1
