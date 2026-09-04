import { invoke } from '@tauri-apps/api/core';

declare const __ZENTRA_PLATFORM__: string;
export const isMobileRuntime = () => typeof __ZENTRA_PLATFORM__ !== 'undefined' && ['ios', 'android'].includes(__ZENTRA_PLATFORM__);

export async function materializeMobileFile(source: string): Promise<string> {
  if (!isMobileRuntime()) return source;
  const { copyFile, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs');
  const { appCacheDir, join } = await import('@tauri-apps/api/path');
  const originalName = source.startsWith('content:') ? await invoke<string>('mobile_file_name', { url: source }) : decodeURIComponent(source.split('/').at(-1)?.split('?')[0] || 'document');
  const name = originalName.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-140);
  await mkdir('imports', { baseDir: BaseDirectory.AppCache, recursive: true });
  const destination = await join(await appCacheDir(), 'imports', `${crypto.randomUUID()}-${name}`);
  await copyFile(source, destination);
  return destination;
}

export async function shareMobileExport(path: string) {
  if (isMobileRuntime()) await invoke('share_mobile_export', { path });
}
