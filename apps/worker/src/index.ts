import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { LineClient } from '@line-crm/line-sdk';
import {
  getLineAccounts,
  getTrafficPoolBySlug,
  getTrafficPoolById,
  getRandomPoolAccount,
  getPoolAccounts,
  getEntryRouteByRefCode,
} from '@line-crm/db';
import { type WorkersAiBinding } from './services/llm/workers-ai.js';
import { type VectorizeIndex } from './services/vectorize.js';
import { processStepDeliveries } from './services/step-delivery.js';
import { processScheduledBroadcasts, processQueuedBroadcasts } from './services/broadcast.js';
import { isRichMenuScheduleEnabled, processRichMenuSchedule } from './services/rich-menu-schedule.js';
import { processReminderDeliveries } from './services/reminder-delivery.js';
import { checkAccountHealth } from './services/ban-monitor.js';
import { refreshLineAccessTokens } from './services/token-refresh.js';
import { processInsightFetch } from './services/insight-fetcher.js';
import { processDueReminders } from './services/booking-reminders.js';
import { resolveFormalooClient } from './services/formaloo-client.js';
import { runFormalooDriftCheck } from './services/formaloo-drift.js';
import { runExpirer } from './services/booking-expirer.js';
import { processDueEventReminders } from './services/event-booking-reminders.js';
import { runEventBookingExpirer } from './services/event-booking-expirer.js';
import { sendEventBookingNotification } from './services/event-booking-notifier.js';
import { sendBookingNotification } from './services/booking-notifier.js';
import { DEFAULT_ACCOUNT_SETTINGS } from './services/booking-types.js';
import { authMiddleware } from './middleware/auth.js';
import { permissionMiddleware } from './middleware/permission-middleware.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { webhook } from './routes/webhook.js';
import { friends } from './routes/friends.js';
import { tags } from './routes/tags.js';
import { scenarios } from './routes/scenarios.js';
import { broadcasts } from './routes/broadcasts.js';
import { users } from './routes/users.js';
import { lineAccounts } from './routes/line-accounts.js';
import { conversions } from './routes/conversions.js';
import { affiliates } from './routes/affiliates.js';
import { duplicates } from './routes/duplicates.js';
import { usersGrouped } from './routes/users-grouped.js';
import { inbox } from './routes/inbox.js';
import { openapi } from './routes/openapi.js';
import { liffRoutes } from './routes/liff.js';
// Round 3 ルート
import { webhooks } from './routes/webhooks.js';
import { calendar } from './routes/calendar.js';
import { reminders } from './routes/reminders.js';
import { scoring } from './routes/scoring.js';
import { templates } from './routes/templates.js';
import { chats } from './routes/chats.js';
import { conversations } from './routes/conversations.js';
// notifications ルート (notification_rules CRUD + notifications 一覧) は
// インボックス機能 (/api/inbox/unanswered) に置き換えたため削除。
// DB テーブル notification_rules / notifications は archive 目的で残してある。
import { stripe } from './routes/stripe.js';
import { health } from './routes/health.js';
import { automations } from './routes/automations.js';
import { richMenus } from './routes/rich-menus.js';
import { trackedLinks } from './routes/tracked-links.js';
import { entryRoutes } from './routes/entry-routes.js';
import { forms } from './routes/forms.js';
import { formsAdvanced } from './routes/forms-advanced.js';
import { formalooWorkspaces } from './routes/formaloo-workspaces.js';
import { formalooFolders } from './routes/formaloo-folders.js';
import { formalooPublic } from './routes/formaloo-public.js';
import { adPlatforms } from './routes/ad-platforms.js';
import { staff } from './routes/staff.js';
import { roles } from './routes/roles.js';
import { capabilities } from './routes/capabilities.js';
import { images } from './routes/images.js';
import { accountSettings } from './routes/account-settings.js';
import { setup } from './routes/setup.js';
import { autoReplies } from './routes/auto-replies.js';
import { faqs } from './routes/faqs.js';
import { knowledge } from './routes/knowledge.js';
import { staffDocs } from './routes/staff-docs.js';
import { adminAuth } from './routes/admin-auth.js';
import { resolveCorsOrigin } from './middleware/admin-auth-config.js';
import booking from './routes/booking.js';
import events from './routes/events.js';
import { trafficPools } from './routes/traffic-pools.js';
import { meetCallback } from './routes/meet-callback.js';
import { messageTemplates } from './routes/message-templates.js';
import dedupPreview from './routes/dedup-preview.js';
import { profileRefresh } from './routes/profile-refresh.js';
import { richMenuGroups } from './routes/rich-menu-groups.js';
import adminVersion from './routes/admin-version.js';
import adminUpdate from './routes/admin-update.js';
import { csvExports } from './routes/exports.js';
import { responseSchedules } from './routes/response-schedules.js';
import { savedSearches } from './routes/saved-searches.js';
import { cannedResponses } from './routes/canned-responses.js';
import { campaigns } from './routes/campaigns.js';
import { senderPresets } from './routes/sender-presets.js';
import { abTests } from './routes/ab-tests.js';
import { templatePacks } from './routes/template-packs.js';
import { richMenuAnalytics } from './routes/rich-menu-analytics.js';
import { lp } from './routes/lp.js';

export type Env = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    ASSETS: Fetcher;
    LINE_CHANNEL_SECRET: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    API_KEY: string;
    LEGACY_API_KEY?: string;
    LIFF_URL: string;
    LINE_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_SECRET: string;
    WORKER_URL: string;
    // Admin auth topology (see middleware/admin-auth-config.ts):
    ADMIN_ORIGIN?: string;          // Comma-separated admin web origin allowlist for credentialed CORS
    ADMIN_COOKIE_SAMESITE?: string; // Optional override: 'Strict' | 'Lax' | 'None'
    ADMIN_ALLOW_CROSS_SITE?: string; // 'true' opts into SameSite=None cross-site cookies
    // ID/PASS 認証の切替 flag (batch F / GC-7)。'true' で login フォームの {apiKey} 経路を server-side
    // 拒否 (Bearer=SDK/MCP は不変)。未設定/false は並行期間 (apiKey login も通る)。wrangler.ks.toml の
    // 不可侵設定 (FAQ_BOT_ENABLED 等) とは別 env = 混同・不可侵違反を防ぐ。off で即 rollback。
    PASSWORD_AUTH_REQUIRED?: string;
    X_HARNESS_URL?: string;  // Optional: X Harness API URL for account linking
    IG_HARNESS_URL?: string;  // Optional: IG Harness API URL for cross-platform linking
    IG_HARNESS_LINK_SECRET?: string;  // Shared secret for IG Harness link-line webhook
    // Phase 5 self-update — consumed by /admin/update/*. Defaults live in
    // wrangler.toml [vars]; secrets (CF_API_TOKEN, ADMIN_API_KEY) come from
    // `wrangler secret put`. All are optional at the type level so the rest
    // of the worker still type-checks in test environments that don't set
    // them; the /admin/update/* route guards on their presence at runtime.
    ADMIN_API_KEY?: string;
    CF_API_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
    WORKER_NAME?: string;
    ADMIN_PAGES_PROJECT?: string;
    LIFF_PAGES_PROJECT?: string;
    D1_DATABASE_ID?: string;
    FAQ_BOT_ENABLED?: string;
    // line-staff-docs-chat — スタッフ用 常駐 RAG chat の入口 flag。既定 OFF (未設定/'false') = dark-ship。
    // 'true' で /api/staff-docs/* が有効化 + capabilities に staffDocs:true が出て web 常駐パネルが描画される
    // (両面 OFF: route 404 かつ panel 非表示)。既存 FAQ_BOT_ENABLED 等の不可侵設定とは別 env で独立 rollback。
    STAFF_DOCS_ENABLED?: string;
    // Phase B (B-1) — Workers AI 接続層。`[ai] binding = "AI"` と AI_* [vars] は
    // infra 工程 (closer/デプロイ) で wrangler に追記する (repo/コードに literal を置かない)。
    // 未設定 dev では createFaqAiRuntime() が null を返し AI 後段を組まない (dark-ship default)。
    AI?: WorkersAiBinding;
    AI_MODEL_ID?: string;                       // 非 deprecated 8B 級 (default 値は wrangler [vars])
    AI_RETRIEVAL_FLOOR?: string;                // 暫定 Retrieval 下限 (< threshold 0.6)
    AI_TIMEOUT_MS?: string;                      // generate timeout
    AI_NEURON_PER_MTOK_IN?: string;             // token→neuron 換算係数 (モデル別)
    AI_NEURON_PER_MTOK_OUT?: string;
    AI_DAILY_NEURON_BUDGET_GLOBAL?: string;     // 共有無料枠の合算上限 (fail-closed)
    AI_DAILY_NEURON_BUDGET_PER_ACCOUNT?: string;
    // Phase B (B-4) — chunks live RAG。`[[vectorize]] binding = "VECTORIZE"` と AI_EMBED_* [vars] は
    // infra 工程で wrangler に追記 (repo に literal を置かない)。未設定 dev では chunk 検索を組まず
    // faqs-only=B-3 挙動へ degrade (createFaqAiRuntime が vectorize:null / embedModelId:undefined)。
    VECTORIZE?: VectorizeIndex;                  // Vectorize index binding
    AI_EMBED_MODEL_ID?: string;                  // 非 deprecated 多言語 embedding (default 値は wrangler [vars])
    AI_CHUNK_RELEVANCE_FLOOR?: string;           // chunk 採用の正規化 cosine [0,1] 下限
    AI_EMBED_NEURON_PER_MTOK?: string;           // embed の token→neuron 換算係数
    // G17 期間限定リッチメニューの自動切替 flag。既定 OFF (未設定) = dark-ship。
    // KS 本番は crons=[] でもあり二重に dark (owner 立会後に 'true' + cron 設定で有効化)。
    RICH_MENU_SCHEDULE_ENABLED?: string;
    MANIFEST_URL?: string;
    WORKER_PUBLIC_URL?: string;
    ADMIN_PUBLIC_URL?: string;
    LIFF_PUBLIC_URL?: string;
    // Formaloo 統合 (F-1 / line-formaloo-forms)。secret は `wrangler secret put` で供給 (closer 工程 S-1)。
    // repo/wrangler.toml に生値を置かない (PUBLIC OSS / D-2)。未設定 dev では createFormalooClient() が
    // null を返し fail-soft (高機能フォーム機能のみ無効・既存機能は無影響)。
    FORMALOO_API_KEY?: string;
    FORMALOO_API_SECRET?: string;
    // F6-1 envelope 暗号化キー管理の親鍵 (KEK)。base64 32byte。`wrangler secret put FORMALOO_KEK` で
    //   供給する (closer 工程 S-1 / repo・wrangler.toml・D1 に生値を置かない / D-2 / N-15)。未投入 dev は
    //   resolveFormalooClient の登録 workspace 解決が null に落ち、env 単一鍵 fallback (workspaceId=null)
    //   のみ動作する (dark-ship 安全)。
    FORMALOO_KEK?: string;
    // F-3 回答 webhook の自前認証 (closer 工程 S-1 で wrangler secret put)。repo に生値を置かない (D-2)。
    //   FORMALOO_WEBHOOK_TOKEN  : /formaloo/webhook/:token の推測不能 path token (N-4)。未設定 dev は fail-closed。
    //   FORMALOO_WEBHOOK_SECRET : HMAC 署名検証の共有鍵 (N-12)。署名スキームは live 確定 (sidecar 申し送り)。
    FORMALOO_WEBHOOK_TOKEN?: string;
    FORMALOO_WEBHOOK_SECRET?: string;
    // 順方向 fr_id 署名 friend token の専用鍵 (C1 / R-F4 / formaloo-sheets-roundtrip)。
    //   `wrangler secret put FORMALOO_FRIEND_TOKEN_SECRET` で供給 (closer 工程 / repo に生値を置かない / D-2)。
    //   既存 auth API_KEY / FORMALOO_WEBHOOK_SECRET とは別鍵で分離 (fr_id が権限昇格に使えない境界)。
    //   未設定 dev では /fo/:id が prefill を付けず生 Formaloo URL 相当へ degrade (fail-closed / §plan 6)。
    FORMALOO_FRIEND_TOKEN_SECRET?: string;
    // formaloo-auto-pull: 定義 drift の定期検知 (6h cron) の flag。
    //   FORMALOO_DRIFT_ENABLED : drift-check job 自体の入口ガード (既定 ON / env で 'false' 即停止 = rollback)。
    //   FORMALOO_DRIFT_AUTO_APPLY : 安全な drift の自動反映 (案 A='true' / 案 B='false' = 既定 = 通知のみ dark-ship)。
    //     owner が案 A を選んだら wrangler.toml で 'true' に flip するだけ (通知/バッジは OFF でも動く)。
    FORMALOO_DRIFT_ENABLED?: string;
    FORMALOO_DRIFT_AUTO_APPLY?: string;
    // 弾M (form-post-edit): あと編集 (①管理者編集 + ②本人再入場 prefill) の全体 kill-switch。
    //   未設定 = 無効 (fail-closed / rollback 経路)。allow_post_edit トグルと AND で gate する。
    //   有効化は `wrangler secret put`/[vars] で 'true' 供給 (owner 立会後・repo に literal 置かない)。
    FORM_POST_EDIT_ENABLED?: string;
    // 弾L (form-edit-mail-link): 署名付き編集トークンの専用鍵 (Phase A / 公開編集 route の token 検証)。
    //   `wrangler secret put FORMALOO_EDIT_TOKEN_SECRET` で供給 (repo に生値を置かない / D-2)。既存 friend token /
    //   webhook secret / auth API_KEY とは別鍵で分離 (編集トークンが署名/認証系の権限昇格に使えない境界)。
    //   未設定 dev は verifyEditToken が fail-closed (null) = 公開編集 route が全 token を拒否 (=機能到達不能)。
    FORMALOO_EDIT_TOKEN_SECRET?: string;
    // submissions-visibility-fix: /api/forms-advanced/:id/rows の Formaloo live reconcile を無効化する
    //   kill-switch。未設定/其他 = reconcile ON (既定・兄弟 /stats・/rows/:rowId と同じ SoT=Formaloo モデル)。
    //   'true' = mirror-only の旧挙動へ即 rollback (Formaloo を一切叩かない)。
    FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE?: string;
    // line-reentry-prefill-fix (Layer A): reconcile-pull が署名 fr_id を verify して friend_id を復元する
    //   機能だけを緊急停止する kill-switch。未設定/其他 = 復元 ON (既定・reconcile が friend_id を fail-closed 復元)。
    //   'true' = friend_id 復元のみ停止 (reconcile のミラー充填・一覧表示は従来通り継続)。additive rollback。
    FORMALOO_RECONCILE_FRIEND_LINK_DISABLE?: string;
    // fr-id-capture-fix (T-C3/D-4): publish 経路の friend system hidden field (fr_id/fr_name) 冪等 auto-push の
    //   kill-switch。未設定/其他 = 有効 (既定・両テナント共通 publish で alias='fr_id'/'fr_name' の hidden field を
    //   冪等 ensure)。'1' = auto-push を短絡 (byte 同等 / rollback = Layer A land 済の現状へ完全復帰)。
    FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE?: string;
    // fr-id-capture-fix (T-C1/codex#8): fr_name (氏名=PII) の auto-push だけを切る owner-gate。未設定/其他 = 有効
    //   (owner 意図 = Google Sheets 帰属可読化)。'1' = fr_id のみ push し fr_name を作らない (PII 保守テナント向け)。
    FORMALOO_FR_NAME_AUTOPUSH_DISABLE?: string;
    // fr-id-hardening-round2 (③): 新規 field の alias=slug 標準付与の kill-switch。未設定/其他 = 有効 (両テナント共通
    //   publish で createField が POST 応答 slug に PATCH {alias:slug} を付与し /fo の slug-keyed 回答 prefill を成立させる)。
    //   '1' = alias 自動付与を短絡 (byte 同等 / rollback)。Formaloo hosted prefill は alias 一致でのみ発火するため既定有効が正。
    FORMALOO_FIELD_ALIAS_AUTOSET_DISABLE?: string;
    // form-jp-reapply-impl: hosted UI chrome 日本語化だけを緊急停止する kill-switch。
    //   未設定/其他 = ON、'1' = localizationJa 入力の永続化・localized_content GET/PATCH/confirm を完全短絡。
    //   rollback はこの値を '1' にして再 deploy。既存 definition_json と他の Formaloo 同期は byte 同等で維持する。
    FORMALOO_LOCALIZATION_DISABLE?: string;
    // form-jp-reapply-impl: 一発再反映 endpoint 全体の kill-switch。未設定/其他 = 有効、'1' = 入口で 503。
    //   rollback はこの値を '1' にして再 deploy。DB lookup/sync 更新/credential 解決/外部通信を全て短絡する。
    FORMALOO_REAPPLY_DISABLE?: string;
  };
  Variables: {
    // roleId (G64): custom role の FK。env-owner / built-in role は null/undefined。
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff'; roleId?: string | null };
  };
};

export const app = new Hono<Env>();

// CORS — credentialed cookie auth cannot use a wildcard origin. Reflect only
// same-origin requests and origins on the ADMIN_ORIGIN allowlist; everything
// else gets no Access-Control-Allow-Origin header (browser blocks it). Bearer
// SDK/MCP callers send no Origin header and are unaffected.
app.use('*', cors({
  origin: (origin, c) => resolveCorsOrigin(c.env, origin, c.req.url),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // x-admin-api-key: /updates ページが /admin/update/* を呼ぶ際の認証ヘッダ。
  // これが無いと *.pages.dev からの preflight で弾かれ「履歴取得に失敗: Failed to fetch」になる (reviewer G1)。
  allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'x-admin-api-key'],
  maxAge: 600,
}));

// Rate limiting — runs before auth to block abuse early
app.use('*', rateLimitMiddleware);

// Auth middleware — skips /webhook and /docs automatically
app.use('*', authMiddleware);

// Permission middleware (G64) — runs right after auth so 全 /api route を 1 点で gate する。
// built-in role は byte-identical (全許可) / custom role のみ機能単位 ON/OFF を enforce する。
app.use('*', permissionMiddleware);

// Mount route groups — MVP & Round 2
app.route('/', webhook);
app.route('/', friends);
app.route('/', tags);
app.route('/', scenarios);
app.route('/', broadcasts);
app.route('/', users);
app.route('/', lineAccounts);
app.route('/', conversions);
app.route('/', affiliates);
app.route('/', duplicates);
app.route('/', usersGrouped);
app.route('/', inbox);
app.route('/', openapi);
app.route('/', liffRoutes);

// Mount route groups — Round 3
app.route('/', webhooks);
app.route('/', calendar);
app.route('/', reminders);
app.route('/', scoring);
app.route('/', templates);
app.route('/', chats);
app.route('/', conversations);
app.route('/', stripe);
app.route('/', health);
app.route('/', automations);
app.route('/', richMenus);
app.route('/', trackedLinks);
app.route('/', entryRoutes);
app.route('/', forms);
app.route('/', formsAdvanced);
app.route('/', formalooWorkspaces);
app.route('/', formalooFolders);
app.route('/', formalooPublic);
app.route('/', adPlatforms);
app.route('/', staff);
app.route('/', roles);
app.route('/', capabilities);
app.route('/', images);
app.route('/', setup);
app.route('/', autoReplies);
app.route('/', faqs);
app.route('/', knowledge);
app.route('/', staffDocs);
app.route('/', adminAuth);
app.route('/', trafficPools);
app.route('/', booking);
app.route('/', events);
app.route('/', accountSettings);
app.route('/', meetCallback);
app.route('/', messageTemplates);
app.route('/', dedupPreview);
app.route('/', profileRefresh);
app.route('/', richMenuGroups);
app.route('/', csvExports);
app.route('/', responseSchedules);
app.route('/', savedSearches);
app.route('/', cannedResponses);
app.route('/', campaigns);
app.route('/', senderPresets);
app.route('/', abTests);
app.route('/', templatePacks);
app.route('/', richMenuAnalytics);
// harness-lp-hosting: LP 置き場。公開 serve (/lp/:slug) は ASSETS catch-all (notFound) より前に
// 登録されるため Hono 先勝ちで catch-all に食われない (T-A8)。admin (/api/lp/*) は authMiddleware +
// permissionMiddleware ('analytics') で gate される。
app.route('/', lp);

// Phase 5 (upgrade flow) — public build metadata endpoint. Mounted under
// /admin/ but intentionally unauthenticated: the dashboard fetches /admin/version
// before login to render the upgrade banner, and the returned hashes are
// derivable from the deployed bundle. /admin/update/* (Task 18) layers
// ADMIN_API_KEY middleware on subpaths.
app.route('/admin', adminVersion);
// Phase 5 Task 18 — self-update endpoints guarded by x-admin-api-key.
// authMiddleware skips non-/api/ paths so this router owns its own auth gate.
app.route('/admin/update', adminUpdate);

// Self-hosted QR code proxy — prevents leaking ref tokens to third-party services
app.get('/api/qr', async (c) => {
  const data = c.req.query('data');
  if (!data) return c.text('Missing data param', 400);
  const size = c.req.query('size') || '240x240';
  const upstream = `https://api.qrserver.com/v1/create-qr-code/?size=${encodeURIComponent(size)}&data=${encodeURIComponent(data)}`;
  const res = await fetch(upstream);
  if (!res.ok) return c.text('QR generation failed', 502);
  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

// Short link: /r/:ref → universal landing page with LINE open button
// Supports query params: ?form=FORM_ID (auto-push form after friend add)
// Mobile: single CTA → LIFF URL (Universal Link). No UA detection.
// Desktop: QR code encodes LIFF URL.
// Stuck users opt into /r/:ref/help for Safari escape instructions.
app.get('/r/:ref', async (c) => {
  const ref = c.req.param('ref');
  const formId = c.req.query('form') || '';

  // Resolve LIFF URL — priority:
  //   1. entry_route.pool_id (if ref maps to a referral link)
  //   2. URL query ?pool=
  //   3. 'main' fallback
  let liffUrl = c.env.LIFF_URL;
  let pool: Awaited<ReturnType<typeof getTrafficPoolBySlug>> | null = null;

  // 1. entry_route lookup. getTrafficPoolById (unlike getTrafficPoolBySlug)
  // does not filter on is_active, so we ignore disabled pools explicitly to
  // honor the operator's pause action.
  //
  // NOTE: we intentionally do NOT record a ref_tracking row here. The
  // /auth/callback + /api/liff/link path already writes a tracking row when
  // OAuth/LIFF completes, and writing a second landing-page row would
  // double-count every successful click in getEntryRouteFunnel. Landing-page
  // drop-off (clicks that never reach OAuth) is therefore not visible in the
  // funnel; that limitation is intentional pending a dedicated click table.
  const route = await getEntryRouteByRefCode(c.env.DB, ref);
  if (route?.pool_id) {
    const candidate = await getTrafficPoolById(c.env.DB, route.pool_id);
    if (candidate?.is_active) pool = candidate;
  }

  // 2 / 3. fallback to URL query or 'main'
  if (!pool) {
    const poolSlug = c.req.query('pool') || 'main';
    pool = await getTrafficPoolBySlug(c.env.DB, poolSlug);
  }

  if (pool) {
    const account = await getRandomPoolAccount(c.env.DB, pool.id);
    if (account) {
      if (account.liff_id) liffUrl = `https://liff.line.me/${account.liff_id}`;
    } else {
      const allAccounts = await getPoolAccounts(c.env.DB, pool.id);
      if (allAccounts.length === 0) {
        if (pool.liff_id) liffUrl = `https://liff.line.me/${pool.liff_id}`;
      }
    }
  }

  // Build LIFF URL with params (direct link for Universal Link)
  const liffIdMatch = liffUrl.match(/liff\.line\.me\/([0-9]+-[A-Za-z0-9]+)/);
  const liffParams = new URLSearchParams();
  if (liffIdMatch) liffParams.set('liffId', liffIdMatch[1]);
  if (ref) liffParams.set('ref', ref);
  if (formId) liffParams.set('form', formId);
  const gate = c.req.query('gate');
  if (gate) liffParams.set('gate', gate);
  const xh = c.req.query('xh');
  if (xh) liffParams.set('xh', xh);
  const ig = c.req.query('ig');
  if (ig) liffParams.set('ig', ig);
  const liffTarget = liffParams.toString() ? `${liffUrl}?${liffParams.toString()}` : liffUrl;

  // Help link carries the *resolved* liff target as `t=` so the help page
  // displays the exact URL the user should paste into a real browser. Without
  // this, pooled refs would re-roll the random pool account on each /r/:ref
  // visit and the help-page paste URL could end up at a different LINE
  // account than the one originally chosen for this user.
  const helpUrl = `/r/${encodeURIComponent(ref)}/help?t=${encodeURIComponent(liffTarget)}`;

  const ua = (c.req.header('user-agent') || '').toLowerCase();
  const isMobile = /iphone|ipad|android|mobile/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);

  if (isMobile) {
    // OS-aware mobile UI. Per-browser detection (X / IG / FB) intentionally avoided —
    // we only branch on iOS vs Android because the recovery primitives differ:
    //   iOS: long-press the link → iOS context menu shows "LINEで開く" even inside
    //        WKWebView in-app browsers that block tap-driven Universal Links.
    //   Android: intent:// URL launches LINE directly via Android's intent system,
    //        which works even when in-app browsers swallow https links.
    // The same liff.line.me URL still drives Universal Link on the iOS button —
    // long-press is a recovery hint, not a replacement.

    // Build Android intent URL — strips the https:// prefix and appends the intent
    // metadata so Chrome / in-app browsers hand off to the LINE app package.
    // L-Step uses the same shape: jp.naver.line.android with browsable category.
    // S.browser_fallback_url makes Chrome fall back to plain HTTPS when LINE
    // isn't installed or the WebView refuses the intent, so Android users
    // never hit a dead end (they at least land on liff.line.me web).
    const liffPath = liffTarget.replace(/^https:\/\//, '');
    const intentFallback = encodeURIComponent(liffTarget);
    const androidIntent = `intent://${liffPath}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=jp.naver.line.android;S.browser_fallback_url=${intentFallback};end`;
    const buttonHref = isAndroid ? androidIntent : liffTarget;
    // iOS shows long-press hint; Android relies on intent URL alone (long-press
    // on Android opens "Open with…" which is noisier than the intent route).
    const longPressHint = isIOS
      ? '<p class="hint">※開かない場合はボタンを<strong>長押し</strong>して「LINEで開く」を選択</p>'
      : '';

    return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE で開く</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:360px;width:90%;padding:40px 28px 32px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.msg{font-size:15px;color:#444;font-weight:500;margin-bottom:28px;line-height:1.6}
.btn{display:block;width:100%;padding:16px;border:none;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;box-shadow:0 2px 12px rgba(6,199,85,0.2);transition:all .15s}
.btn:active{transform:scale(0.98);opacity:.9}
.hint{font-size:11px;color:#888;margin-top:10px;line-height:1.6}
.hint strong{color:#06C755;font-weight:700}
.help{font-size:12px;color:#999;margin-top:18px;line-height:1.5}
.help a{color:#999;text-decoration:underline}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="msg">友達追加して始める</p>
<a href="${buttonHref}" class="btn">LINEで開く</a>
${longPressHint}
<p class="help">うまく開けない方は <a href="${helpUrl}">こちら</a></p>
</div>
</body>
</html>`);
  }

  // PC: show QR code page — QR encodes LIFF URL directly
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE で開く</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:480px;width:90%;padding:48px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.msg{font-size:15px;color:#444;font-weight:500;margin-bottom:32px;line-height:1.6}
.qr{background:#f9f9f9;border-radius:16px;padding:24px;display:inline-block;margin-bottom:24px;border:1px solid rgba(0,0,0,0.04)}
.qr img{display:block;width:240px;height:240px}
.hint{font-size:13px;color:#999;line-height:1.6}
.footer{font-size:11px;color:#bbb;margin-top:24px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="msg">スマートフォンで QR コードを読み取ってください</p>
<div class="qr">
<img src="/api/qr?size=240x240&data=${encodeURIComponent(liffTarget)}" alt="QR Code">
</div>
<p class="hint">LINE アプリのカメラまたは<br>スマートフォンのカメラで読み取れます</p>
<p class="footer">友だち追加で全機能を無料体験できます</p>
</div>
</body>
</html>`);
});

// /r/:ref/help — opt-in recovery page when "LINEで開く" didn't launch the app.
// Method 1 (long-press) is iOS's escape hatch — works inside X / IG / FB
// in-app browsers because iOS's context menu is system-level UI floating
// above the WKWebView, so it surfaces "LINEで開く" even when tap-driven
// Universal Links are blocked. This is the L-Step approach.
// Method 2 (URL copy → external browser) is the universal fallback.
// No LINE-Login-web fallback exposed — friction kills conversion.
app.get('/r/:ref/help', (c) => {
  const ref = c.req.param('ref');
  const reqUrl = new URL(c.req.url);
  // Prefer the resolved liff target passed by /r/:ref via ?t= so pooled refs
  // do not re-roll on retry. Fall back to the short /r/:ref URL only when
  // ?t= is missing (e.g. direct navigation to /help without coming from /r/).
  // Reject anything that is not an https://liff.line.me/* URL — never trust
  // user-supplied open redirects.
  const tParam = c.req.query('t') || '';
  let displayUrl: string;
  if (tParam && /^https:\/\/liff\.line\.me\//.test(tParam)) {
    displayUrl = tParam;
  } else {
    // Strip ?t= if it sneaks in unvalidated, but keep other query params
    // (form, gate, xh, ig, pool) for the /r/:ref re-entry.
    const safeParams = new URLSearchParams(reqUrl.search);
    safeParams.delete('t');
    const qs = safeParams.toString();
    displayUrl = `${reqUrl.origin}/r/${encodeURIComponent(ref)}${qs ? '?' + qs : ''}`;
  }
  // Escape URL for safe embedding in HTML attributes and a visible <code>-style block.
  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const urlForHtml = escapeHtml(displayUrl);

  const ua = (c.req.header('user-agent') || '').toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);
  const browserName = isIOS ? 'Safari' : isAndroid ? 'Chrome' : 'ブラウザ（iPhoneは Safari／Androidは Chrome）';

  // Long-press recovery is iOS-only. On Android the intent:// URL on the
  // main page already handles the equivalent recovery without help-page UI.
  const longPressBlock = isIOS ? `<div class="method">
<div class="method-num">1</div>
<div class="method-body">
<div class="method-title">長押しで開く（最も簡単）</div>
<div class="method-desc">前のページに戻り、緑の「LINEで開く」ボタンを<strong>長押し</strong>。表示されたメニューから「<strong>LINEで開く</strong>」を選択してください。</div>
</div>
</div>` : '';
  const copyMethodNum = isIOS ? '2' : '1';

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINEを開く方法</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);max-width:400px;width:100%;padding:28px 24px;border:1px solid rgba(0,0,0,0.04)}
.title{font-size:17px;color:#333;font-weight:700;margin-bottom:20px;text-align:center;line-height:1.5}
.method{display:flex;gap:12px;margin-bottom:20px;align-items:flex-start}
.method-num{flex-shrink:0;width:28px;height:28px;border-radius:50%;background:#06C755;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.method-body{flex:1}
.method-title{font-size:14px;font-weight:700;color:#333;margin-bottom:6px}
.method-desc{font-size:13px;color:#666;line-height:1.7}
.method-desc strong{color:#06C755;font-weight:700}
.copy-section{background:#f9f9f9;border-radius:12px;padding:16px;margin-top:8px}
.url-box{background:#fff;border:1px solid #e5e7e5;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#333;word-break:break-all;line-height:1.5;user-select:all;-webkit-user-select:all}
.copy-btn{display:block;width:100%;padding:12px;border:none;border-radius:10px;font-size:13px;font-weight:600;text-align:center;color:#fff;background:#06C755;cursor:pointer;margin-bottom:10px;transition:all .15s;font-family:inherit}
.copy-btn:active{transform:scale(0.98);opacity:.9}
.copy-btn.copied{background:#999}
.copy-hint{font-size:11px;color:#aaa;text-align:center;margin-bottom:8px;line-height:1.5}
.steps{font-size:12px;color:#666;line-height:1.8;padding-left:18px;margin-top:6px}
.steps li::marker{color:#06C755;font-weight:700}
</style>
</head>
<body>
<div class="card">
<p class="title">LINEを開く方法</p>
${longPressBlock}
<div class="method">
<div class="method-num">${copyMethodNum}</div>
<div class="method-body">
<div class="method-title">${browserName}で開く</div>
<div class="method-desc">URLをコピーして${browserName}のアドレスバーに貼り付け</div>
<div class="copy-section">
<div class="url-box" id="urlBox">${urlForHtml}</div>
<button class="copy-btn" id="copyBtn" type="button" data-url="${urlForHtml}">URLをコピー</button>
<p class="copy-hint">うまくコピーできない場合は上のURLを長押しで選択</p>
<ol class="steps">
<li>ホームに戻る</li>
<li>${browserName}を開く</li>
<li>アドレスバーに貼り付け</li>
<li>「LINEで開く」をタップ</li>
</ol>
</div>
</div>
</div>
</div>
<script>
(function(){
  var btn = document.getElementById('copyBtn');
  var url = btn.getAttribute('data-url');
  function showCopied(){
    btn.textContent = '✓ コピーしました';
    btn.classList.add('copied');
    setTimeout(function(){
      btn.textContent = 'URLをコピー';
      btn.classList.remove('copied');
    }, 2000);
  }
  function showFailed(){
    btn.textContent = '上のURLを長押しでコピー';
    btn.classList.add('copied');
    setTimeout(function(){
      btn.textContent = 'URLをコピー';
      btn.classList.remove('copied');
    }, 3000);
  }
  function execFallback(text){
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }
  btn.addEventListener('click', function(){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(showCopied, function(){
        if (execFallback(url)) { showCopied(); } else { showFailed(); }
      });
    } else if (execFallback(url)) {
      showCopied();
    } else {
      showFailed();
    }
  });
})();
</script>
</body>
</html>`);
});

// Convenience redirect for /book path
app.get('/book', (c) => c.redirect('/?page=book'));

// 404 fallback — API paths return JSON 404, everything else serves from static assets (LIFF/admin)
export const notFoundHandler = async (c: Parameters<typeof app.notFound>[0] extends (ctx: infer C) => unknown ? C : never) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/') || path === '/webhook' || path === '/docs' || path === '/openapi.json') {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  // Serve static assets (admin dashboard, LIFF pages)
  if (c.env.ASSETS && typeof c.env.ASSETS.fetch === 'function') {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ success: false, error: 'Not found' }, 404);
};

app.notFound(notFoundHandler);

// Scheduled handler for cron triggers — runs for all active LINE accounts
async function scheduled(
  event: ScheduledEvent,
  env: Env['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  // Get all active accounts from DB
  const dbAccounts = await getLineAccounts(env.DB);

  // Build LineClient map for insight fetching (keyed by account id)
  const lineClients = new Map<string, LineClient>();
  for (const account of dbAccounts) {
    if (account.is_active) {
      lineClients.set(account.id, new LineClient(account.channel_access_token));
    }
  }
  const defaultLineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

  // 配信系は1回だけ実行（内部でfriendのline_account_idから正しいlineClientを動的解決）
  // 以前はアカウントごとにループしていたが、アカウントフィルタなしのDBクエリで
  // 全アカウントの配信が各ループで重複実行されていたバグを修正
  const jobs = [];
  jobs.push(
    processStepDeliveries(env.DB, defaultLineClient, env.WORKER_URL),
    processScheduledBroadcasts(env.DB, defaultLineClient, env.WORKER_URL),
    processReminderDeliveries(env.DB, defaultLineClient),
  );
  // キュー処理は1回だけ実行（内部でアカウント別lineClientを解決する）
  // ロック解除: タイムアウトでstuckした配信を復旧
  const { recoverStalledBroadcasts, recoverStuckDeliveries } = await import('@line-crm/db');
  jobs.push(recoverStuckDeliveries(env.DB));
  jobs.push(recoverStalledBroadcasts(env.DB));
  jobs.push(processQueuedBroadcasts(env.DB, defaultLineClient, env.WORKER_URL));
  jobs.push(checkAccountHealth(env.DB));
  jobs.push(refreshLineAccessTokens(env.DB));
  // G17 期間限定リッチメニュー: RICH_MENU_SCHEDULE_ENABLED='true' の時だけ切替計画 job を push。
  // 既定 OFF = job 自体が追加されず dark。onActivate/onExpire を注入しないため、たとえ flag ON でも
  // LINE menu 切替 API は叩かず計画をログするだけ (実切替の配線は owner 立会後)。KS 本番 crons=[] で
  // scheduled 自体が発火しないため二重 dark-ship。
  if (isRichMenuScheduleEnabled(env)) {
    jobs.push(processRichMenuSchedule(env.DB).catch((e) => console.error('[rich-menu-schedule] error:', e)));
  }

  await Promise.allSettled(jobs);

  // Fetch broadcast insights (runs daily, self-throttled)
  try {
    await processInsightFetch(env.DB, lineClients, defaultLineClient);
  } catch (e) {
    console.error('Insight fetch error:', e);
  }

  // Booking reminders — every 5-minute tick scans due reminders.
  try {
    const result = await processDueReminders(env.DB, {
      now: new Date(),
      sender: sendBookingNotification,
      reminderHoursBefore: DEFAULT_ACCOUNT_SETTINGS.reminder_hours_before,
    });
    if (result.sent + result.failed > 0) {
      console.log(`[booking-reminders] sent=${result.sent} failed=${result.failed}`);
    }
  } catch (e) {
    console.error('booking-reminders error:', e);
  }

  // Booking expirer — runs only on the 6h cron tick.
  if (event.cron === '0 */6 * * *') {
    try {
      const result = await runExpirer(env.DB, {
        now: new Date(),
        sender: sendBookingNotification,
      });
      console.log(
        `[booking-expirer] expired=${result.expired} idempotency_purged=${result.idempotencyPurged}`,
      );
    } catch (e) {
      console.error('booking-expirer error:', e);
    }
  }

  // Event-booking reminders — every 5-minute tick scans due reminders.
  try {
    const result = await processDueEventReminders(env.DB, {
      now: new Date(),
      sender: sendEventBookingNotification,
    });
    if (result.sent + result.failed > 0) {
      console.log(`[event-booking-reminders] sent=${result.sent} failed=${result.failed}`);
    }
  } catch (e) {
    console.error('event-booking-reminders error:', e);
  }

  // Event-booking expirer — 6h cron tick.
  if (event.cron === '0 */6 * * *') {
    try {
      const result = await runEventBookingExpirer(env.DB, { now: new Date() });
      console.log(
        `[event-booking-expirer] expired=${result.expired} idempotency_purged=${result.idempotencyPurged}`,
      );
    } catch (e) {
      console.error('event-booking-expirer error:', e);
    }
  }

  // Formaloo 定義 drift 検知 — 6h cron tick のみ (5min tick では走らない / 予算保護 R9)。
  // 入口ガード: FORMALOO_DRIFT_ENABLED='false' で即停止 (rollback / 既定 ON)。
  // auto-apply は FORMALOO_DRIFT_AUTO_APPLY='true' の時だけ (既定 OFF = 通知のみ dark-ship)。
  if (event.cron === '0 */6 * * *' && env.FORMALOO_DRIFT_ENABLED !== 'false') {
    try {
      const summary = await runFormalooDriftCheck({
        db: env.DB,
        resolveClient: (wsid) => resolveFormalooClient(env, wsid),
        autoApplyEnabled: env.FORMALOO_DRIFT_AUTO_APPLY === 'true',
        // fr-id-hardening-round2 / T-C5 配線: friend system field 健全性 (fr_id/fr_name の削除/visible化/重複/logic破棄) を
        //   drift 走行点で監査し不健全なら既存 drift 通知経路で surface。autopush 有効テナントでのみ動く (無効なら fr_id 不在が
        //   正常ゆえ false alarm を出さない)。fr_name は owner-gate と同じ判定。
        systemFieldHealthCheck: env.FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE !== '1',
        includeOwnerGatedSystemFields: env.FORMALOO_FR_NAME_AUTOPUSH_DISABLE !== '1',
      });
      console.log(
        `[formaloo-drift] checked=${summary.checked} bootstrapped=${summary.bootstrapped} auto=${summary.autoApplied} notified=${summary.notified} conflicts=${summary.conflicts} inSync=${summary.inSync} skipped=${summary.skipped} sysFieldUnhealthy=${summary.systemFieldUnhealthy}`,
      );
    } catch (e) {
      console.error('[formaloo-drift] error:', e);
    }
  }

  // Cross-account duplicate detection — disabled.
  // The cron used to materialize duplicates into the tag system but the 1k-subrequest
  // budget can't drain a 1k+ candidate backlog, and a live SELECT against
  // friends.picture_url / display_name / status_message gives the same answer
  // on demand. Replacement: a /api/duplicates endpoint plus a dashboard view
  // (planned alongside the multi-provider UI work). Keeping the service file
  // (apps/worker/src/services/duplicate-detect.ts) and the existing
  // `重複:` tag rows untouched until that replacement lands.
}

export default {
  fetch: app.fetch,
  scheduled,
};
// redeploy trigger
