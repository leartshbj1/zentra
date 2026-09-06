import type { StorageBackend } from '@wllama/wllama/esm/storage';

/** Safari/WKWebView may expose Cache Storage but not OPFS in a worker. The
 * response body is streamed to disk, without a second full model in memory. */
export class PayslipModelCache implements StorageBackend {
  isSupported() { return typeof caches !== 'undefined'; }
  private url(key: string, metadata = false) {
    // A synthetic HTTPS key also works on Tauri's custom URL scheme. It is
    // used only as a Cache Storage key; no request is sent to this host.
    return `https://zentra-model-cache.invalid/__zentra_qwen_cache__/${metadata ? 'size/' : 'data/'}${encodeURIComponent(key)}`;
  }
  private open() { return caches.open('zentra-qwen-gguf-v1'); }
  async read(key: string): Promise<Blob | null> {
    const response = await (await this.open()).match(this.url(key));
    return response ? response.blob() : null;
  }
  async write(key: string, stream: ReadableStream<Uint8Array>) {
    const cache = await this.open();
    const reader = stream.getReader();
    let size = 0;
    await cache.delete(this.url(key, true));
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          size += value.byteLength; controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    try {
      await cache.put(this.url(key), new Response(counted));
      await cache.put(this.url(key, true), new Response(String(size)));
    } catch (error) {
      await this.delete(key);
      throw error;
    }
  }
  async getSize(key: string) {
    const cache = await this.open();
    const response = await cache.match(this.url(key, true));
    if (!response || !(await cache.match(this.url(key)))) return -1;
    const size = Number(await response.text());
    return Number.isSafeInteger(size) && size >= 0 ? size : -1;
  }
  async list() {
    const requests = await (await this.open()).keys();
    const entries = [];
    for (const request of requests) {
      const match = /\/__zentra_qwen_cache__\/data\/(.+)$/.exec(new URL(request.url).pathname);
      if (match) { const key = decodeURIComponent(match[1]); entries.push({ key, size: await this.getSize(key) }); }
    }
    return entries;
  }
  async delete(key: string) {
    const cache = await this.open();
    await cache.delete(this.url(key)); await cache.delete(this.url(key, true));
  }
}
