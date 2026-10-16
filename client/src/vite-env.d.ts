/// <reference types="vite/client" />

/**
 * Vite exposes typed environment variables through `import.meta.env`.
 * Declare the ones SourceIQ reads so they are checked rather than `any`.
 */
interface ImportMetaEnv {
  /** Absolute API base URL. Defaults to a relative `/api` (proxied in dev). */
  readonly VITE_API_URL?: string;
  /** Where the dev server proxies `/api`. */
  readonly VITE_DEV_API_URL?: string;
  readonly VITE_PORT?: string;
  readonly VITE_HOST?: string;
  readonly VITE_PREVIEW_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}