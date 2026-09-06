export const ZENTRA_VERSION = '1.41.0';
export const ZENTRA_GITHUB_RELEASE_PATH = `https://github.com/leartshbj1/zentra/releases/tag/v${ZENTRA_VERSION}`;
export const ZENTRA_ANDROID_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-Android-arm64-test.apk`;
export const ZENTRA_IPHONE_IPA_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-iPhone-unsigned.ipa`;
export const ZENTRA_IOS_PREVIEW_PATH = `https://github.com/leartshbj1/zentra/releases/download/v${ZENTRA_VERSION}/Zentra-${ZENTRA_VERSION}-iOS-simulateur.zip`;
export const ZENTRA_INSTALLER_NAME = `Zentra_${ZENTRA_VERSION}_x64-setup.exe`;
export const ZENTRA_RELEASES_ORIGIN =
  'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases';
export const ZENTRA_INSTALLER_PATH = `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_INSTALLER_NAME}`;
export const ZENTRA_INSTALLER_CHECKSUM_PATH = `${ZENTRA_INSTALLER_PATH}.sha256.txt`;
export const ZENTRA_INSTALLER_SIZE_MIB = '9,38';
export const ZENTRA_INSTALLER_SHA256 =
  '0F381F13342F4A8C1D01724858E97A1E5220B6ACCAA91E6D133263A0B8F2C0F2';

export const ZENTRA_MAC_DMG_NAME = `Zentra_${ZENTRA_VERSION}_macos-universal.dmg`;
export const ZENTRA_MAC_DMG_PATH = `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_MAC_DMG_NAME}`;
export const ZENTRA_MAC_DMG_CHECKSUM_PATH = `${ZENTRA_MAC_DMG_PATH}.sha256.txt`;
export const ZENTRA_MAC_DMG_SIZE_MIB = '21,63';
export const ZENTRA_MAC_DMG_SHA256 =
  '83B1941099CDE1ABCBC7A8C664B66FEA3A7C1C2B4C40EB68B24A74C5C18CE886';
