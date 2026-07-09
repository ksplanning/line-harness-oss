// =============================================================================
// Formaloo 高機能フォーム publish gate 状態機械 (F-2 / T-B3 / N-7 誤配信防止)
// -----------------------------------------------------------------------------
// draft → in_review → published の状態機械。draft/in_review の間は公開 URL・埋め込みコードを
// 一切発行しない (draft フォーム経由で TRINA 実顧客へ LINE 送信/公開が発火しない = failure_observable 回避)。
// draft→published の直行は禁止 = owner レビュー (in_review) を必ず挟む。published→draft (unpublish/編集)
// で URL は即無効化される。
// =============================================================================

export const BUILDER_STATUSES = ['draft', 'in_review', 'published'] as const;
export type BuilderStatus = (typeof BUILDER_STATUSES)[number];

export function isBuilderStatus(v: unknown): v is BuilderStatus {
  return typeof v === 'string' && (BUILDER_STATUSES as readonly string[]).includes(v);
}

/** 許可された状態遷移 (from → to)。同一状態は no-op = 非遷移。 */
const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [BuilderStatus, BuilderStatus]> = [
  ['draft', 'in_review'], // レビュー依頼
  ['in_review', 'published'], // owner 承認 → 公開
  ['in_review', 'draft'], // 差し戻し
  ['published', 'draft'], // 編集/unpublish → URL 無効化
];

export function canTransition(from: BuilderStatus, to: BuilderStatus): boolean {
  return ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** N-7: 公開/埋め込み URL が有効なのは published のみ。 */
export function isPublicUrlEnabled(status: BuilderStatus): boolean {
  return status === 'published';
}

/**
 * 公開フォーム URL を返す。published かつ Formaloo 側 address 確定時のみ。
 * それ以外 (draft/in_review / 未 push) は null = URL 発行不可 (誤配信防止 N-7)。
 */
export function buildPublicUrl(status: BuilderStatus, publicAddress: string | null | undefined): string | null {
  if (!isPublicUrlEnabled(status)) return null;
  if (!publicAddress) return null;
  return publicAddress;
}

/**
 * HP 埋め込みコード (iframe) を返す (R4)。published のみ。draft/in_review は null。
 */
export function buildEmbedCode(
  status: BuilderStatus,
  publicAddress: string | null | undefined,
  opts: { width?: string; height?: string; title?: string } = {},
): string | null {
  const url = buildPublicUrl(status, publicAddress);
  if (!url) return null;
  const width = opts.width ?? '100%';
  const height = opts.height ?? '700';
  const title = (opts.title ?? 'form').replace(/"/g, '&quot;');
  const safeUrl = url.replace(/"/g, '&quot;');
  return `<iframe src="${safeUrl}" width="${width}" height="${height}" frameborder="0" title="${title}" style="border:0;max-width:100%"></iframe>`;
}

/**
 * HP 埋め込みコード (script 変種 / R4)。published のみ。draft/in_review は null。
 * 外部 CDN 非依存の self-contained script (iframe をその場に注入) = どの HP にも安全に貼れる。
 * 埋め込み先が iframe を嫌う CMS でも script 1 行で設置できる (owner の HP 事情に依存しない)。
 */
export function buildScriptEmbedCode(
  status: BuilderStatus,
  publicAddress: string | null | undefined,
  opts: { height?: string } = {},
): string | null {
  const url = buildPublicUrl(status, publicAddress);
  if (!url) return null;
  const height = opts.height ?? '700';
  // URL は JSON.stringify で JS 文字列リテラルとして安全にエスケープ (改行/引用符/</script> 対策込み)。
  const jsUrl = JSON.stringify(url).replace(/</g, '\\u003c');
  return `<script>(function(){var f=document.createElement("iframe");f.src=${jsUrl};f.width="100%";f.height="${height}";f.frameBorder="0";f.style.border="0";f.style.maxWidth="100%";var s=document.currentScript;s.parentNode.insertBefore(f,s);})();</script>`;
}
