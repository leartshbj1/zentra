export const ZENTRA_VERSION = '1.46.1';
export const ZENTRA_GITHUB_RELEASE_PATH = `https://github.com/leartshbj1/zentra/releases/tag/v${ZENTRA_VERSION}`;
export const ZENTRA_ANDROID_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-Android-arm64-test.apk`;
export const ZENTRA_IPHONE_IPA_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-iPhone-unsigned.ipa`;
export const ZENTRA_IOS_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-iOS-simulateur.zip`;
export const ZENTRA_INSTALLER_NAME = `Zentra_${ZENTRA_VERSION}_x64-setup.exe`;
export const ZENTRA_RELEASES_ORIGIN =
  'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases';
export const ZENTRA_INSTALLER_PATH = `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_INSTALLER_NAME}`;
export const ZENTRA_INSTALLER_CHECKSUM_PATH = `${ZENTRA_INSTALLER_PATH}.sha256.txt`;
export const ZENTRA_INSTALLER_SIZE_MIB = '21,60';
export const ZENTRA_INSTALLER_SHA256 =
  'B618ACA9F9E3E6FF931BC1AE5330299D1B716D254B72912B5DA5AA0C2BF28E1D';

export const ZENTRA_MAC_DMG_NAME = `Zentra_${ZENTRA_VERSION}_macos-universal.dmg`;
export const ZENTRA_MAC_DMG_PATH = `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_MAC_DMG_NAME}`;
export const ZENTRA_MAC_DMG_CHECKSUM_PATH = `${ZENTRA_MAC_DMG_PATH}.sha256.txt`;
export const ZENTRA_MAC_DMG_SIZE_MIB = '46,32';
export const ZENTRA_MAC_DMG_SHA256 =
  'AE7D6F2B34E903EB4CB7306F569D6AE5B9093B6E0D904AA7121C3C19E786BC66';
