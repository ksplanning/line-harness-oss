# Piecemaker build-env 差分 — ks 値焼き込みを避ける再 build 手順（§10 B-4）

> 正本: `.plans/2026-07-15-piecemaker-line-harness/plan.md §10 B-4 / §3-D`。
> **地雷**: build 成果物（`apps/web/out` の静的 export・`apps/worker/dist` の client bundle）には
> **build 時の env が焼き込まれる**。ks 用に build した成果物をそのまま Piecemaker に deploy すると、
> ks の API URL / LIFF / admin key / MANIFEST を埋め込んだバンドルを顧客に配ってしまう（顧客混線）。
> ∴ **テナント deploy は必ずそのテナントの env で fresh build する。ks の out/・dist を使い回さない。**

---

## 面 1 — apps/web（admin パネル / Cloudflare Pages）

- apps/web は Next.js で `next.config.ts` が `output: 'export'`（**static export**）。build 出力は `apps/web/out/`。
- 静的 export のため **`NEXT_PUBLIC_*` は build 時にバンドルへ焼き込まれる**（runtime で差し替え不可）。
- 焼き込まれる build env（`apps/web/src` で実測）:

| env | 意味 | Piecemaker 値 |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | admin → worker API base | **Piecemaker worker URL**（ks の URL を焼くと管理画面が ks worker を叩く＝混線） |
| `NEXT_PUBLIC_ADMIN_API_KEY` | admin Bearer | **Piecemaker の API_KEY**（Box BOLT・ks 鍵を焼かない） |
| `NEXT_PUBLIC_MANIFEST_URL` | update banner の manifest | Piecemaker 運用方針に従う（H-7: self-update は使わない運用） |
| `NEXT_PUBLIC_UPDATE_BANNER_ENABLED` | update バナー表示 | テナント方針 |

再 build → deploy:

```bash
cd apps/web
NEXT_PUBLIC_API_URL=https://<piecemaker-worker>.workers.dev \
NEXT_PUBLIC_ADMIN_API_KEY=<piecemaker admin key from BOLT> \
NEXT_PUBLIC_MANIFEST_URL=<piecemaker or disabled> \
NEXT_PUBLIC_UPDATE_BANNER_ENABLED=false \
  pnpm build
# → apps/web/out/ が Piecemaker 値で焼き上がる。ks の out/ は使い回さない（使い回し禁止）。
npx wrangler pages deploy apps/web/out --project-name=line-harness-piecemaker-admin
```

## 面 2 — apps/worker の LIFF client（worker 統合 Static Assets）

- worker の client bundle（LIFF 配信）は Vite で build され、`import.meta.env.VITE_*` が焼き込まれる。
- 焼き込まれる build env（`apps/worker/src/client` で実測）:

| env | 意味 | Piecemaker 値 |
|---|---|---|
| `VITE_WORKER_ORIGIN` | LIFF 復路の same-origin アンカー（CX-1 cross-origin 漏出防止） | **Piecemaker worker origin**（= WORKER_PUBLIC_URL）。pages.dev/LIFF origin を入れると F-1 無限ループ再発 |
| `VITE_LIFF_ID` | default LIFF id | Piecemaker LIFF id（account 固有 LIFF は復路 `&liffId=` で上書き） |
| `VITE_BOT_BASIC_ID` | Bot Basic id | Piecemaker OA の basic id |

再 build → deploy:

```bash
cd apps/worker
VITE_WORKER_ORIGIN=https://<piecemaker-worker>.workers.dev \
VITE_LIFF_ID=<piecemaker liff id> \
VITE_BOT_BASIC_ID=@<piecemaker bot> \
  pnpm build
# → dist/ が Piecemaker 値で焼き上がる。ks 用 dist を使い回さない。
CLOUDFLARE_API_TOKEN=<pm> CLOUDFLARE_ACCOUNT_ID=<pm> \
  npx wrangler deploy dist/line_harness/index.js --config wrangler.piecemaker.toml
```

---

## チェックリスト（deploy 前）

- [ ] apps/web を Piecemaker `NEXT_PUBLIC_*` で **再 build**した（ks の `out/` を再利用していない）。
- [ ] apps/worker を Piecemaker `VITE_*` で **再 build**した（ks の `dist/` を再利用していない）。
- [ ] `VITE_WORKER_ORIGIN` が **Piecemaker worker origin**（pages.dev/LIFF origin でない）。
- [ ] admin key / LIFF id / worker URL に **ks の値が 1 つも混ざっていない**（grep で `line-harness-ks` / `web-8af` 0 hit）。
- [ ] secret 系（`NEXT_PUBLIC_ADMIN_API_KEY` 等）は Box BOLT の Piecemaker 値から注入し、repo に焼かない。
