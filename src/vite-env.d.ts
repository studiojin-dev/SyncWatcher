/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LEMON_SQUEEZY_CHECKOUT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
