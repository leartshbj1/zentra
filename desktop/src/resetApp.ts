export async function clearLocalAppPreferences() {
  localStorage.clear();
  sessionStorage.clear();
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) await caches.delete(name);
  }
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
    for (const db of await indexedDB.databases()) {
      if (!db.name) continue;
      await new Promise<void>((resolve,reject)=>{
        const request=indexedDB.deleteDatabase(db.name!);
        request.onsuccess=()=>resolve();
        request.onerror=()=>reject(request.error);
        request.onblocked=()=>reject(new Error('Fermez les autres fenêtres de Zentra, puis réessayez la remise à zéro.'));
      });
    }
  }
  if (typeof navigator.storage?.getDirectory === 'function') {
    const root=await navigator.storage.getDirectory();
    for await (const [name] of root as FileSystemDirectoryHandle & AsyncIterable<[string,unknown]>) {
      await root.removeEntry(name,{recursive:true});
    }
  }
}
