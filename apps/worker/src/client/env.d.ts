/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_LIFF_ID: string;
  readonly VITE_BOT_BASIC_ID: string;
  readonly VITE_CALENDAR_CONNECTION_ID: string;
  /**
   * Configured WORKER canonical origin (= wrangler [vars] WORKER_PUBLIC_URL, e.g.
   * https://your-worker.workers.dev). Anchor for the復路 lu same-origin guard (CX-1): the /fo/:id
   * tracking route always lives on the WORKER origin, so lu is only carried when the redirect target
   * matches THIS origin — never the LIFF/pages origin. Unset → falls back to pathname-only (legacy,
   * round-trip preserved, cross-origin leak not yet closed). Set at build: VITE_WORKER_ORIGIN=…workers.dev.
   */
  readonly VITE_WORKER_ORIGIN: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
