import { Channel, invoke } from '@tauri-apps/api/core';

export type NativeDestination = 'dashboard' | 'projects' | 'quotes' | 'menu';
type NavigationState = { selected: NativeDestination; visible: boolean; onNavigate: (destination: NativeDestination) => void };
const destinations: readonly string[] = ['dashboard', 'projects', 'quotes', 'menu'];

// Serialize teardown and registration too: an old React effect must never hide
// the dock after the next effect has connected it (including Strict Mode).
let operations = Promise.resolve();

export function createNativeNavigationSession(command: string, read: () => NavigationState, onAvailable: (available: boolean) => void) {
  let disposed = false;
  let failed = false;
  let channel: Channel<{ id: string }> | undefined;
  const enqueue = (work: () => Promise<void>) => {
    operations = operations.then(work).catch(() => {});
    return operations;
  };
  const hide = async () => {
    if (!channel) return;
    channel.onmessage = () => {};
    try { await invoke(command, { selected: read().selected, visible: false }); } catch { /* HTML navigation stays available. */ }
  };
  return {
    update: () => enqueue(async () => {
      if (disposed || failed) return;
      const state = read();
      const registering = !channel;
      if (!channel) channel = new Channel((event) => {
        const current = read();
        if (!disposed && !failed && current.visible && event && destinations.includes(event.id)) current.onNavigate(event.id as NativeDestination);
      });
      try {
        const result = await invoke<{ available: boolean }>(command, {
          selected: state.selected, visible: state.visible,
          // A Channel is a subscription, not a configuration value. Sending it
          // twice recreates the Rust sequence counter and closes its JS callback.
          ...(registering ? { onNavigate: channel } : {}),
        });
        if (!disposed) onAvailable(result.available === true);
        if (!result.available) { failed = true; await hide(); }
      } catch {
        failed = true;
        if (!disposed) onAvailable(false);
        await hide();
      }
    }),
    dispose: () => {
      disposed = true;
      return enqueue(hide);
    },
  };
}
