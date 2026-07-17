// =============================================================================
// route-terminal-phase2 (Track 1) — フォーム送信後リダイレクト URL の canonical 契約 (worker + web 共有)。
// -----------------------------------------------------------------------------
// owner 要望 (2026-07-18): 送信後に「指定した URL (特別な LP)」へ実遷移させたい・飛び先を LINE 内 /
//   外部ブラウザで選べるようにしたい。
// 🚨 spike 実測 (2026-07-18 / .plans/2026-07-18-route-terminal-phase2/spike-results.md):
//   - M1: form 直下 meta `form_redirects_after_submit` に URL を PATCH → hosted 送信後に実ナビゲーション
//     (native・既存 query intact / H1/H5)。フォーム単位 redirect の正式機構。
//   - M7: Formaloo server は `javascript:` / `data:` / `not-a-url` / `ftp:` / `//protocol-relative` を
//     **全て無検証で STORE** する = server は守ってくれない → harness 側で **https-only 検証を MUST** 化。
//   - M8: `openExternalBrowser=1` は LINE 公式 (LIFF 除く通常 web URL) で外部ブラウザ起動 param。redirect
//     URL に決定的付与可 (文字列末尾連結でなく URL 構造で set)。
//   - CX-9 phishing 面: 任意 https を許すため userinfo 付き URL (https://user:pass@host) を拒否する。
// form-copy.ts (form-jp-localization) を写経元にした additive-optional / whitelist / 空 drop 契約。
// fingerprint 非関与: redirect は form 直下 meta (fields+logic の canonicalDefinitionProjection に入らない)
//   = cron drift 誤検知に入らない (formCopy と同型)。
// =============================================================================

// WHATWG URL は Node18+ / Cloudflare Workers 双方の runtime global。本パッケージの tsconfig lib=ES2022 は
//   URL/URLSearchParams を型宣言しない (DOM/WebWorker lib 非搭載) ため、使用箇所のみ module-scoped ambient で
//   型付けする (fingerprint.ts の crypto/TextEncoder ambient と同型 = 最小 blast radius)。実体は runtime global。
declare class URL {
  constructor(url: string, base?: string);
  protocol: string;
  hostname: string;
  username: string;
  password: string;
  hash: string;
  readonly searchParams: { get(name: string): string | null; set(name: string, value: string): void };
  toString(): string;
}

/** redirect URL 文字列の上限 (過長 URL 拒否 / DoS + 保存肥大化防止)。 */
export const REDIRECT_URL_MAX_LEN = 2048;

/**
 * owner が個別指定できる送信後 redirect 設定 (additive-optional・design/formCopy と同列)。
 * key 不在 = 未指定 (触らない)。
 */
export interface FormRedirect {
  /** 送信後の飛び先 URL (Formaloo `form_redirects_after_submit`)。https のみ。 */
  url?: string;
  /** 外部ブラウザで開くか (true = redirect URL に openExternalBrowser=1 を付与 / LINE 外部起動 M8)。 */
  openExternalBrowser?: boolean;
  /**
   * 回答データを redirect 先へ付与するか (Formaloo `include_data_on_redirect` / M3 実在)。
   * MVP では builder に露出しない (CI-1: append 形式が spike 未検証・PII 外部送出リスク) が、
   * harness-LP-router 後続案件の接続点として shared 型に **reserved** で残す。
   */
  includeData?: boolean;
}

/** harness canonical key の順序安定リスト (normalize / push 写像が反復に使う)。 */
export const FORM_REDIRECT_KEYS = ['url', 'openExternalBrowser', 'includeData'] as const;

export type FormRedirectKey = (typeof FORM_REDIRECT_KEYS)[number];

/**
 * harness canonical key → Formaloo form 直フィールド名 (worker push が利用)。
 * openExternalBrowser は独立フィールドでなく url 自体に付与する param ゆえ写像に含めない。
 */
export const FORM_REDIRECT_TO_FORMALOO = {
  url: 'form_redirects_after_submit',
  includeData: 'include_data_on_redirect',
} as const;

/** validateRedirectUrl の結果 (discriminated union / fail-soft: throw せず ok/error を返す)。 */
export type RedirectUrlValidation = { ok: true; url: string } | { ok: false; error: string };

function fail(error: string): RedirectUrlValidation {
  return { ok: false, error };
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * redirect URL の https-only 検証 (URL 検証の単一入口 / harness-contracts §5)。
 *   - 非 string / 空 / 過長 (>2048) / protocol-relative (`//host`) / パース不能 / 非 https スキーム
 *     (javascript:/data:/http:/ftp:) / userinfo 付き (CX-9 phishing 面) を全て reject する。
 *   - opts.openExternalBrowser 指定時は **付与後** の target URL が 2048 を超えないことも検証する (CX-6)。
 * server は M7 で無検証 STORE する実測ゆえ、builder(UX) と worker(authoritative gate) の二層で本関数を通す。
 */
export function validateRedirectUrl(
  raw: unknown,
  opts?: { openExternalBrowser?: boolean },
): RedirectUrlValidation {
  if (typeof raw !== 'string') return fail('URL を文字列で入力してください');
  const url = raw.trim();
  if (!url) return fail('URL が空です');
  if (url.length > REDIRECT_URL_MAX_LEN) return fail(`URL が長すぎます（${REDIRECT_URL_MAX_LEN} 文字以内）`);
  // protocol-relative (//host) は base 無しの URL() が throw するが、意図を明示するため先に弾く。
  if (url.startsWith('//')) return fail('スキームの無い URL は使用できません（https:// を付けてください）');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('URL の形式が正しくありません');
  }
  if (parsed.protocol !== 'https:') return fail('https:// で始まる URL のみ使用できます');
  if (!parsed.hostname) return fail('URL にホスト名がありません');
  if (parsed.username || parsed.password) return fail('ユーザー情報付き URL（user:pass@）は使用できません');
  // CX-6: openExternalBrowser=1 を付与すると数十 byte 伸びる → 付与後の長さも検証 (押し出しで 2048 超過を拒否)。
  if (opts?.openExternalBrowser) {
    const target = buildRedirectTargetUrl(url, true);
    if (target.length > REDIRECT_URL_MAX_LEN) {
      return fail(`外部ブラウザ指定を付けると URL が長すぎます（${REDIRECT_URL_MAX_LEN} 文字以内）`);
    }
  }
  return { ok: true, url };
}

/**
 * redirect 先 URL に openExternalBrowser=1 を **URL 構造で** 付与する (M8・文字列末尾連結でない)。
 *   - openExternalBrowser=false/undefined では付与せず url をそのまま返す (LINE 内ブラウザ既定)。
 *   - URLSearchParams.set で既存 openExternalBrowser=0 を 1 に上書きし二重付与しない。
 *   - #fragment を保持し query が fragment 後に来ない (URL.toString() が正しく直列化)。
 *   - パース不能な url は変換せずそのまま返す (validateRedirectUrl を通した後の呼出が前提だが防御)。
 */
export function buildRedirectTargetUrl(url: string, openExternalBrowser?: boolean): string {
  if (!openExternalBrowser) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.searchParams.set('openExternalBrowser', '1');
  return parsed.toString();
}

/**
 * 不明キーを剥がし、更新に安全な FormRedirect に正規化する (normalizeFormCopy と同型の whitelist)。
 *   - 未知キーは drop。非 object 入力は {}。
 *   - url は string を trim し validateRedirectUrl (openExternalBrowser 込み) を通過した分のみ保持。
 *     空 / 非 string / 検証失敗 url は drop → url が無ければ openExternalBrowser/includeData も無意味ゆえ {}。
 *   - openExternalBrowser / includeData は boolean のみ保持 (url ありのときだけ)。
 * key 不在は結果でも不在 (absent)。誤クリア防止のため空 object から既定を生成しない。
 */
export function normalizeFormRedirect(raw: unknown): FormRedirect {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const urlRaw = hasOwn(input, 'url') && typeof input.url === 'string' ? input.url.trim() : '';
  if (!urlRaw) return {}; // url 無し = 未指定 (openExternalBrowser 単独は無意味 = 落とす)
  const oeb = input.openExternalBrowser === true;
  const v = validateRedirectUrl(urlRaw, { openExternalBrowser: oeb });
  if (!v.ok) return {}; // 検証失敗 url は drop (危険スキーム / 過長)
  const out: FormRedirect = { url: v.url };
  if (hasOwn(input, 'openExternalBrowser') && typeof input.openExternalBrowser === 'boolean') {
    out.openExternalBrowser = input.openExternalBrowser;
  }
  if (hasOwn(input, 'includeData') && typeof input.includeData === 'boolean') {
    out.includeData = input.includeData;
  }
  return out;
}
