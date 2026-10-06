#!/usr/bin/env bash
# Prepare only the Apple runner dependencies; this receipt does not prove a build.
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  printf 'usage: %s LOG_DIRECTORY\n' "$0" >&2
  exit 64
fi
if [[ "$(uname -s)" != Darwin ]]; then
  printf 'Apple Homebrew preparation requires macOS.\n' >&2
  exit 65
fi
command -v brew >/dev/null
mkdir -p "$1"
run_dir="$(mktemp -d "$1/run.XXXXXXXX")"
step=initialization
trap 'result=$?; printf "exit_code=%s\nlast_step=%s\n" "$result" "$step" >"$run_dir/status.txt"' EXIT
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_COLOR=1
export NO_COLOR=1

run_logged() {
  local label="$1"
  shift
  step="$label"
  if "$@" 2>&1 | tee "$run_dir/$label.log"; then
    return 0
  else
    local pipeline_status=("${PIPESTATUS[@]}")
    if [[ "${pipeline_status[1]}" -ne 0 ]]; then
      printf 'Cannot preserve the complete log for %s.\n' "$label" >&2
      return 125
    fi
    return "${pipeline_status[0]}"
  fi
}

assert_installed() {
  local formula="$1"
  run_logged "installed-$formula" brew list --versions "$formula"
  LC_ALL=C awk -v formula="$formula" '
    $1 == formula && NF >= 2 { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$run_dir/installed-$formula.log"
}

strict_postinstall() {
  local formula="$1"
  assert_installed "$formula"
  run_logged "postinstall-$formula" env HOMEBREW_DEVELOPER=1 \
    brew postinstall --verbose "$formula"
}

install_formula() {
  local formula="$1"
  local postinstall_option=()
  # This documented option separates these two postinstalls from installation.
  # Both are run strictly below before Tauri or any application build can start.
  if [[ "$formula" == ca-certificates || "$formula" == openssl@3 ]]; then
    postinstall_option=(--skip-post-install)
  fi
  run_logged "install-$formula" brew install --force-bottle --verbose \
    "${postinstall_option[@]}" "$formula"
  assert_installed "$formula"
}

run_logged brew-config-before brew config
run_logged brew-update brew update
run_logged brew-config-after brew config

install_formula ca-certificates
strict_postinstall ca-certificates
install_formula openssl@3
strict_postinstall openssl@3
install_formula libimobiledevice
install_formula xcodegen
install_formula cocoapods

step=certificate-paths
brew_prefix="$(brew --prefix)"
openssl_prefix="$(brew --prefix openssl@3)"
export PATH="$brew_prefix/bin:$brew_prefix/sbin:$PATH"
ca_bundle="$brew_prefix/etc/ca-certificates/cert.pem"
openssl_bundle="$brew_prefix/etc/openssl@3/cert.pem"
test -s "$ca_bundle"
test -s "$openssl_bundle"
if [[ ! -L "$openssl_bundle" || ! "$ca_bundle" -ef "$openssl_bundle" ]]; then
  printf 'OpenSSL must reference the identical Homebrew CA bundle through its symlink.\n' >&2
  exit 66
fi
grep -Fq -- '-----BEGIN CERTIFICATE-----' "$ca_bundle"
run_logged openssl-version "$openssl_prefix/bin/openssl" version
run_logged certificate-bundle-parse "$openssl_prefix/bin/openssl" crl2pkcs7 \
  -nocrl -certfile "$ca_bundle" -out "$run_dir/ca-bundle.p7b"
run_logged certificate-bundle-validation "$openssl_prefix/bin/openssl" pkcs7 \
  -in "$run_dir/ca-bundle.p7b" -print_certs -noout
run_logged brew-linkage brew linkage --test openssl@3 libimobiledevice

step=tauri-required-binaries
for tool in idevicesyslog xcodegen pod; do
  command -v "$tool" | tee "$run_dir/path-$tool.log"
  run_logged "version-$tool" "$tool" --version
done
run_logged formula-versions brew list --versions \
  ca-certificates openssl@3 libimobiledevice xcodegen cocoapods
step=homebrew-preparation-complete
printf 'Homebrew dependencies and certificate bundle validated; no application build was performed.\n' \
  | tee "$run_dir/environment-ready.txt"
