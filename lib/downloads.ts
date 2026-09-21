export const ZENTRA_VERSION = '1.46.1';
// Published separately until the exact installation and cross-platform checks pass.
export const ZENTRA_WINDOWS_PREVIEW_VERSION = '1.80.1';
export const ZENTRA_WINDOWS_PREVIEW_NAME = `Zentra_${ZENTRA_WINDOWS_PREVIEW_VERSION}_x64-setup.exe`;
export const ZENTRA_WINDOWS_PREVIEW_PATH = `https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/${ZENTRA_WINDOWS_PREVIEW_NAME}`;
export const ZENTRA_WINDOWS_PREVIEW_SHA256 = 'E2819BDB9A4970EC392CAFA7B63EB9B299A04C99B2FA0F61CD76CB4873223BB9';
export const ZENTRA_WINDOWS_VERSION = ZENTRA_WINDOWS_PREVIEW_VERSION;
export const ZENTRA_MAC_VERSION = '1.80.1';
export const ZENTRA_RELEASE_VERSION = '1.80.1';
export const ZENTRA_GITHUB_RELEASE_PATH = `https://github.com/leartshbj1/zentra/releases/tag/v${ZENTRA_RELEASE_VERSION}`;
export const ZENTRA_ANDROID_VERSION = '1.80.1';
export const ZENTRA_ANDROID_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_ANDROID_VERSION}/Zentra-${ZENTRA_ANDROID_VERSION}-Android-arm64-test.apk`;
export const ZENTRA_IPHONE_VERSION = '1.80.1';
export const ZENTRA_IPHONE_IPA_PATH = `https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/Zentra-${ZENTRA_IPHONE_VERSION}-iPhone-unsigned.ipa`;
export const ZENTRA_IOS_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-iOS-simulateur.zip`;
export const ZENTRA_INSTALLER_NAME = `Zentra_${ZENTRA_WINDOWS_VERSION}_x64-setup.exe`;
export const ZENTRA_RELEASES_ORIGIN =
  'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases';
export const ZENTRA_INSTALLER_PATH = `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_INSTALLER_NAME}`;
export const ZENTRA_INSTALLER_CHECKSUM_PATH = `${ZENTRA_INSTALLER_PATH}.sha256.txt`;
export const ZENTRA_INSTALLER_SIZE_MIB = '22,60';
export const ZENTRA_INSTALLER_SHA256 =
  ZENTRA_WINDOWS_PREVIEW_SHA256;

export const ZENTRA_MAC_DMG_NAME = `Zentra_${ZENTRA_MAC_VERSION}_macos-universal.dmg`;
export const ZENTRA_MAC_DMG_PATH = `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_MAC_DMG_NAME}`;
export const ZENTRA_MAC_DMG_CHECKSUM_PATH = `${ZENTRA_MAC_DMG_PATH}.sha256.txt`;
export const ZENTRA_MAC_DMG_SIZE_MIB = '48,44';
export const ZENTRA_MAC_DMG_SHA256 =
  'D0FB4DDDD723EE24F248476A336B7EDD345ACFDEC16E8F89B0C16EB3A03C611B';
