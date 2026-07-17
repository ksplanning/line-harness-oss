// =============================================================================
// route-terminal-phase2 (Track 2) — ルート別「完了ページ」(Formaloo success-page) の canonical 契約。
// -----------------------------------------------------------------------------
// Phase 2 / OD-2: ABC ルート分岐の末尾で route ごとに完了ページを出し分ける (Phase 1 の
//   jump_to_success_page + submit レールに SP resource を紐づける)。
// 🚨 spike 実測 (Phase 1 + 本案件 spike-results.md §3):
//   - SP は Formaloo `/v3.0/fields/success-page/` の field resource。title + description(plain text) + cover のみ。
//   - **SP description は plain text sanitize** される (M5: <a>/<meta refresh>/<script> は plain text 描画)。
//     → harness 側でも markup/制御文字を除去して XSS 面を閉じる (CX-8: vendor sanitize 依存にしない =
//     将来 renderer 変更に耐える)。SP 単位の外部 URL redirect は構造的に不可 (redirect 系 key 皆無)。
//   - create=HTTP 201 / slug=data.field.slug / read・update・delete は汎用 /v3.0/fields/{slug}/ /
//     **再 POST は非冪等 (別 slug 新規作成) → slug のクライアント永続必須** / form DELETE は SP を cascade せず。
// design/formCopy/formRedirect と同列の additive-optional (値があるときだけ persist = byte 不変)。
// =============================================================================

/**
 * ルート別完了ページ 1 件の canonical 表現 (additive-optional)。
 *  - id: harness 内の安定 id (submit rule の targetFieldId が参照)。
 *  - slug: Formaloo が採番した success-page slug。**未作成なら absent** (reconcile 後に永続)。
 *  - title: 完了ページ見出し (必須)。
 *  - description: 完了ページ本文 (plain text のみ・省略可)。
 */
export interface SuccessPageSpec {
  id: string;
  slug?: string;
  title: string;
  description?: string;
}

/** SuccessPageSpec の canonical key 順序安定リスト (normalize が反復に使う)。 */
export const SUCCESS_PAGE_KEYS = ['id', 'slug', 'title', 'description'] as const;

/**
 * 完了ページ本文を plain text 化する (CX-8: harness 側で XSS 面を閉じる)。
 *   - HTML タグ (`<...>`) を除去 (Formaloo 側 plain-text sanitize に依存しない)。
 *   - 制御文字を除去 (改行 \n / タブ \t は保持 = 本文の改行を壊さない)。
 * リンク化/自動遷移は SP description では native 不可 (M5 DEAD) ゆえ、markup を残す意味がない。
 */
export function sanitizeSuccessPageDescription(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '') // HTML タグ除去
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // 制御文字除去 (\n=0A \t=09 は残す)
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * 不明キーを剥がし、更新に安全な SuccessPageSpec[] に正規化する (normalizeFormCopy と同型の whitelist)。
 *   - 非 array 入力は []。各要素は object でなければ drop。
 *   - id / title が非空 string でなければ drop (SP は id + 見出しが必須)。
 *   - slug は非空 string のときだけ保持 (未作成 SP は absent)。
 *   - description は非空 string を sanitizeSuccessPageDescription で plain text 化して保持 (空/非 string は絶落)。
 *   - 入力順を保持する (route の対応順が意味を持つ)。
 */
export function normalizeSuccessPages(raw: unknown): SuccessPageSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: SuccessPageSpec[] = [];
  for (const el of raw) {
    if (typeof el !== 'object' || el === null || Array.isArray(el)) continue;
    const input = el as Record<string, unknown>;
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!id || !title) continue; // id + title 必須
    const sp: SuccessPageSpec = { id, title };
    if (hasOwn(input, 'slug') && typeof input.slug === 'string' && input.slug.trim()) {
      sp.slug = input.slug.trim();
    }
    if (hasOwn(input, 'description') && typeof input.description === 'string') {
      const desc = sanitizeSuccessPageDescription(input.description).trim();
      if (desc) sp.description = desc;
    }
    out.push(sp);
  }
  return out;
}
