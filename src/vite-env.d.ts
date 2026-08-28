/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Scheme and host of the API, no trailing slash. Empty means same origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
