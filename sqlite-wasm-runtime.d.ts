declare module 'sql.js/dist/sql-wasm-browser.js' {
  import initSqlJs = require('sql.js');
  export default initSqlJs;
}
/** Cloudflare Vite imports precompiled static WASM, never a URL or raw bytes. */
declare module '*.wasm?module' {
  const compiled: WebAssembly.Module;
  export default compiled;
}
declare module '*.wasm' {
  const compiled: WebAssembly.Module;
  export default compiled;
}
