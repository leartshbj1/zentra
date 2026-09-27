export const ZENTRA_VERSION = '1.46.1';
// Published separately until the exact installation and cross-platform checks pass.
export const ZENTRA_WINDOWS_PREVIEW_VERSION = '1.90.2';
export const ZENTRA_WINDOWS_PREVIEW_NAME = `Zentra_${ZENTRA_WINDOWS_PREVIEW_VERSION}_x64-setup.exe`;
export const ZENTRA_WINDOWS_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_WINDOWS_PREVIEW_VERSION}/${ZENTRA_WINDOWS_PREVIEW_NAME}`;
export const ZENTRA_WINDOWS_PREVIEW_SHA256 = '8CB03117B52E94690EB4BFD50F5FC8131B11E6D6187A9D146A3BBFB6885C5AEC';
export const ZENTRA_WINDOWS_VERSION = ZENTRA_WINDOWS_PREVIEW_VERSION;
export const ZENTRA_MAC_VERSION = '1.90.2';
export const ZENTRA_RELEASE_VERSION = '1.90.2';
export const ZENTRA_GITHUB_RELEASE_PATH = `https://github.com/leartshbj1/zentra/releases/tag/v${ZENTRA_RELEASE_VERSION}`;
export const ZENTRA_ANDROID_VERSION = '1.90.2';
export const ZENTRA_ANDROID_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_ANDROID_VERSION}/Zentra-${ZENTRA_ANDROID_VERSION}-Android-arm64-test.apk`;
export const ZENTRA_IPHONE_VERSION = '1.90.2';
export const ZENTRA_IPHONE_IPA_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_IPHONE_VERSION}/Zentra-${ZENTRA_IPHONE_VERSION}-iPhone-unsigned.ipa`;
export const ZENTRA_IOS_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-iOS-simulateur.zip`;
export const ZENTRA_INSTALLER_NAME = `Zentra_${ZENTRA_WINDOWS_VERSION}_x64-setup.exe`;
// Historical updater manifests remain immutable. New website downloads use
// the already verified GitHub assets, independently of account/storage quotas.
export const ZENTRA_RELEASES_ORIGIN =
  'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases';
export const ZENTRA_INSTALLER_PATH = ZENTRA_WINDOWS_PREVIEW_PATH;
export const ZENTRA_INSTALLER_CHECKSUM_PATH = `${ZENTRA_INSTALLER_PATH}.sha256.txt`;
export const ZENTRA_INSTALLER_SIZE_MIB = '23,09';
export const ZENTRA_INSTALLER_SHA256 =
  ZENTRA_WINDOWS_PREVIEW_SHA256;

export const ZENTRA_MAC_DMG_NAME = `Zentra_${ZENTRA_MAC_VERSION}_macos-universal.dmg`;
export const ZENTRA_MAC_DMG_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_MAC_VERSION}/${ZENTRA_MAC_DMG_NAME}`;
export const ZENTRA_MAC_DMG_CHECKSUM_PATH = `${ZENTRA_MAC_DMG_PATH}.sha256.txt`;
export const ZENTRA_MAC_DMG_SIZE_MIB = '51,59';
export const ZENTRA_MAC_DMG_SHA256 =
  'CBE40C44CB940B1AA6FCBEEC6DC80153730B941AC533048EEDD88BBA41897AB0';
