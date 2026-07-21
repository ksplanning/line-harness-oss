import { fetchApi, downloadCsv } from './api'
import type { HarnessField, HarnessLogicRule, FormDesign, FormDesignImages, FormDisplayType, FormCopy, FormRedirect, SuccessPageSpec, FriendMetadataMapping, FormOperationsSettings, FormOperationsSettingsPatch } from '@line-crm/shared'

// =============================================================================
// フォームビルダー (Formaloo-backed) API クライアント (F-2 / T-B1)。fetchApi 経由 (cookie 認証 + CSRF)。
// =============================================================================

export type BuilderStatus = 'draft' | 'in_review' | 'published'
export type RenderBackend = 'formaloo' | 'internal'

export interface AdvancedForm {
  id: string
  title: string
  description: string | null
  formalooSlug: string | null
  renderBackend: RenderBackend
  builderStatus: BuilderStatus
  publishedAt: string | null
  submitCount: number
  fields: HarnessField[]
  logic: HarnessLogicRule[]
  // treasure-b2-form-settings: 非既定値だけを持つ form 単位の運用制御。
  operationsSettings?: FormOperationsSettings | null
  internalAvailability?: {
    status: 'open' | 'upcoming' | 'ended' | 'limit_reached'
    message: string | null
  }
  publicUrl: string | null
  embedCode: string | null
  syncStatus: string
  syncError: string | null
  // formaloo-auto-pull: Formaloo 側定義変更 (drift) の状態 (pull 軸 / sync_status と直交)。
  //   none=なし / detected=更新あり(要確認) / conflict=競合(要確認) / applied=自動反映済。既定は未露出=none 扱い。
  driftStatus?: string
  driftDetectedAt?: string | null
  driftHasWarnings?: boolean
  // preserve-raw (formaloo-logic-fidelity Batch 1): 未編集判定用 fingerprint。rawLogic 逐語は server-side 保持
  // (reload→save は route が D1 の rawLogic を使う)。builder は save で fingerprint を carry する。
  logicFingerprint?: string | null
  // form-design (Batch D): 色/画像テーマ (builder の initialDesign / プレビュー反映用)。未設定は null。
  design?: FormDesign | null
  // 自前 renderer の公開文言。builder と本番 preview の同じ表示に使う。
  formCopy?: FormCopy | null
  // 自前公開の確認モーダルで保存した版だけを公開するための不透明 revision。
  publishRevision?: string
  // form-route-branching (R2): 表示形式 (builder の initialFormType)。未設定は null。
  formType?: FormDisplayType | null
  // route-terminal-phase2 (Track 1): 送信後リダイレクト設定 (builder の initialFormRedirect)。未設定は null。
  //   保存済 redirect を reload で復元し編集/解除できるようにする (CX-3)。
  formRedirect?: FormRedirect | null
  // route-terminal-phase2 (Track 2 / T-E5): ルート別完了ページ (builder の initialSuccessPages)。未設定は null。
  successPages?: SuccessPageSpec[] | null
  friendMetadataMappings?: FriendMetadataMapping[]
  // form-media-limits ③: 回答者後編集の許可フラグ (0=不可 / 1=可)。既定 0=現状挙動。弾S は inert (実効化は弾M)。
  allowPostEdit?: number
  // form-edit-mail-link (弾L): 編集 URL メール送付の許可フラグ (0=送らない / 1=送る)。allow_post_edit=1 でのみ有効。
  allowEditMail?: number
  // form-edit-mail Phase B: server が remote slug と照合して返す、明示選択済み email field の internal id。
  editMailFieldId?: string | null
  // form-route-branching: save 応答の非ブロッキング警告 (jump+simple backstop 等)。envelope top-level から搬送。
  warnings?: string[]
  // F6-2 表示スコープ: lineAccountId は全 role 露出 / workspaceId は owner 応答のみ (非 owner は不在)。
  lineAccountId: string | null
  workspaceId?: string | null
  // F6-3 ハーネス側フォルダ分類 (NULL=未分類 / 全 role 露出)。
  folderId: string | null
  updatedAt: string
}

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
  // form-route-branching: 非ブロッキング警告 (save 応答の top-level)。
  warnings?: string[]
}

// N-8 pull: 再取り込み結果。ok は「builder に適用してよいか」の判別子 (ok:false は note のみ表示 / B2)。
export interface PulledDefinition {
  ok: boolean
  fields: HarnessField[]
  logic: HarnessLogicRule[]
  note: string
  // preserve-raw: builder が opaque 保持し save で carry する (未編集 push で欠けなく再送)。
  rawLogic?: unknown
  logicFingerprint?: string | null
  // form-design (Batch D): Formaloo 側の色/画像テーマを builder へ復元。
  design?: FormDesign
  // form-route-branching (R2): Formaloo 側の表示形式を builder へ復元。
  formType?: FormDisplayType
  // route-terminal-phase2 (Track 2 / T-E5): Formaloo 側の完了ページ (success_page 分離抽出) を builder へ復元。
  successPages?: SuccessPageSpec[]
  // Formaloo GET から逆算した remote 5 項目。UTM は Harness local-only のため含めない。
  operationsSettings?: FormOperationsSettings
}

// preserve-raw: save body に carry する logic メタ (未編集判定 + verbatim 再送素材)。
export interface SaveDefinitionBody {
  fields: HarnessField[]
  logic: HarnessLogicRule[]
  rawLogic?: unknown
  logicFingerprint?: string | null
  // treasure-b2-form-settings: touched key のみ。解除は false/null を明示する。
  operationsSettings?: FormOperationsSettingsPatch
  title?: string
  description?: string | null
  // form-design (Batch D): 色 (canonical hex) + 画像 upload intent (keep/replace/remove)。
  design?: FormDesign
  designImages?: FormDesignImages
  // form-route-branching (R2): 表示形式 (simple/multi_step)。
  formType?: FormDisplayType
  // form-jp-localization: 公開ページ文言 (送信ボタン/完了/送信エラー)。builder が触ったときだけ載る (present-key)。
  formCopy?: FormCopy
  // route-terminal-phase2 (Track 1): 送信後リダイレクト設定。builder が触ったときだけ載る (present-key)。
  //   url 空 + present = clear 意図 (route が form_redirects_after_submit:null で解除)。
  formRedirect?: FormRedirect
  // route-terminal-phase2 (Track 2 / T-E5): ルート別完了ページ。builder が触ったときだけ載る (present-key)。
  successPages?: SuccessPageSpec[]
  // row-status-friend-sync: form 単位の Formaloo field → friend.metadata mapping。
  friendMetadataMappings?: FriendMetadataMapping[]
  // form-media-limits ③: 回答者後編集の許可フラグ (0|1)。harness 側保存のみ (Formaloo push しない)。
  allowPostEdit?: number
  // form-edit-mail-link (弾L): 編集 URL メール送付の許可フラグ (0|1)。harness 側保存のみ (Formaloo push しない)。
  allowEditMail?: number
  // form-edit-mail Phase B: builder 内部 id。worker が email 型を検証し remote slug へ解決する。null=明示解除。
  editMailFieldId?: string | null
}

export const formsAdvancedApi = {
  // F6-2: lineAccountId で表示スコープ絞り。F6-3: folderId で folder 絞りを重ねる (§3.3b 3 状態:
  //   undefined=全フォルダ+未分類 / 実 id=特定フォルダ / 'none' sentinel=未分類のみ)。
  async list(lineAccountId?: string, folderId?: string): Promise<AdvancedForm[]> {
    const p = new URLSearchParams()
    if (lineAccountId) p.set('lineAccountId', lineAccountId)
    if (folderId !== undefined) p.set('folderId', folderId)
    const qs = p.toString()
    return (await fetchApi<Envelope<AdvancedForm[]>>(`/api/forms-advanced${qs ? `?${qs}` : ''}`)).data
  },
  async get(id: string): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}`)).data
  },
  // Internal hosting is additive: keep the long-standing form response byte-compatible
  // and read/write the backend through its own small endpoint.
  async getRenderBackend(id: string): Promise<RenderBackend> {
    return (
      await fetchApi<Envelope<{ renderBackend: RenderBackend }>>(
        `/api/forms-advanced/${encodeURIComponent(id)}/render-backend`,
      )
    ).data.renderBackend
  },
  async setRenderBackend(id: string, renderBackend: RenderBackend): Promise<RenderBackend> {
    return (
      await fetchApi<Envelope<{ renderBackend: RenderBackend }>>(
        `/api/forms-advanced/${encodeURIComponent(id)}/render-backend`,
        {
          method: 'PATCH',
          body: JSON.stringify({ renderBackend }),
        },
      )
    ).data.renderBackend
  },
  // F6-2: lineAccountId(=選択アカウント) + workspaceId(owner 選択時のみ) を渡す。workspace_id の確定は
  // server 権威 (client 指定は owner の active 値のみ採用・非 owner の明示は 403)。
  async create(input: { title: string; description?: string | null; lineAccountId?: string | null; workspaceId?: string | null }): Promise<AdvancedForm> {
    return (
      await fetchApi<Envelope<AdvancedForm>>('/api/forms-advanced', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).data
  },
  async saveDefinition(id: string, def: SaveDefinitionBody, expectedRenderBackend?: RenderBackend): Promise<AdvancedForm> {
    const env = await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}`, {
      method: 'PUT',
      ...(expectedRenderBackend ? { headers: { 'X-Form-Render-Backend': expectedRenderBackend } } : {}),
      body: JSON.stringify(def),
    })
    // form-route-branching: envelope top-level の warnings (jump+simple backstop 等) を form に搬送 (builder が surface)。
    return env.warnings && env.warnings.length ? { ...env.data, warnings: env.warnings } : env.data
  },
  async saveInternalDefinition(id: string, def: SaveDefinitionBody): Promise<void> {
    await fetchApi<Envelope<null>>(
      `/api/forms-advanced/${encodeURIComponent(id)}/internal-definition`,
      { method: 'PUT', body: JSON.stringify(def) },
    )
  },
  // N-8: Formaloo から定義を再取り込み (pull / 非破壊)。ok===true の時だけ builder に反映する。
  async reimport(id: string): Promise<PulledDefinition> {
    return (await fetchApi<Envelope<PulledDefinition>>(`/api/forms-advanced/${id}/pull`)).data
  },
  async submitForReview(id: string, expectedRenderBackend?: RenderBackend): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}/submit-for-review`, {
      method: 'POST',
      ...(expectedRenderBackend ? { headers: { 'X-Form-Render-Backend': expectedRenderBackend } } : {}),
    })).data
  },
  async publish(id: string, publishRevision?: string, expectedRenderBackend?: RenderBackend): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}/publish`, {
      method: 'POST',
      ...(expectedRenderBackend ? { headers: { 'X-Form-Render-Backend': expectedRenderBackend } } : {}),
      ...(publishRevision === undefined
        ? {}
        : { body: JSON.stringify({ publishRevision }) }),
    })).data
  },
  async unpublish(
    id: string,
    expectedRenderBackend?: RenderBackend,
    expectedUpdatedAt?: string,
  ): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}/unpublish`, {
      method: 'POST',
      ...(expectedRenderBackend ? { headers: { 'X-Form-Render-Backend': expectedRenderBackend } } : {}),
      ...(expectedRenderBackend === 'internal' && expectedUpdatedAt
        ? { body: JSON.stringify({ expectedUpdatedAt }) }
        : {}),
    })).data
  },
  async remove(id: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/forms-advanced/${id}`, { method: 'DELETE' })
  },
  // F-5 T-E1: 埋め込みコード + Sheets 連携状態。
  async share(id: string): Promise<ShareInfo> {
    return (await fetchApi<Envelope<ShareInfo>>(`/api/forms-advanced/${id}/share`)).data
  },
  async connectGsheet(id: string): Promise<{ connected: boolean; gsheetUrl: string | null; note: string }> {
    return (await fetchApi<Envelope<{ connected: boolean; gsheetUrl: string | null; note: string }>>(`/api/forms-advanced/${id}/gsheet/connect`, { method: 'POST' })).data
  },
}

// F-5 T-E1: 共有・連携情報。
export interface ShareInfo {
  published: boolean
  publicUrl: string | null
  // T-A5 順方向: LINE 配信用 URL (/fo/:id / 追跡 + fr_id/fr_name prefill)。未公開は null。
  lineDistUrl: string | null
  iframeCode: string | null
  scriptCode: string | null
  gsheetConnected: boolean
  gsheetUrl: string | null
  internalAvailability?: {
    status: 'open' | 'upcoming' | 'ended' | 'limit_reached'
    message: string | null
  }
}

// =============================================================================
// F-4 データコックピット API (T-D1/T-D2)。回答は TRINA 顧客 PII を含み得る (N-9) — 外部送信しない。
// =============================================================================

export interface SubmissionRow {
  id: string
  friendId: string | null
  answers: Record<string, unknown>
  submittedAt: string
  verified: boolean
}
export interface RowsPage {
  rows: SubmissionRow[]
  total: number
  page: number
  pageSize: number
  // form-response-display-fix (T-A1): 列ヘッダーを質問名で描画するための slug→label 対応 (additive・後方互換)。
  //   field_map(formaloo_field_slug) × 定義(label) の join。旧 worker は返さない → optional。
  fields?: Array<{ slug: string; label: string }>
}
/** 弾M (form-post-edit): 編集保存レスポンス (merge 後 answers + ④最終編集情報)。 */
export interface RowEditResult {
  id: string
  answers: Record<string, unknown>
  submittedAt: string
  source: string
  lastEdit: { editorStaffId: string | null; editorName: string | null; editedAt: string } | null
}
/** 弾M: 回答詳細の編集対象 field メタ (編集モードの入力欄生成 + required 検証用)。 */
export interface RowEditFieldMeta {
  slug: string
  label: string
  type: string
  required: boolean
  editable: boolean
}
/** 弾M: 回答詳細 (drill-through) + 編集コンテキスト (allowPostEdit / editable fields / ④lastEdit)。 */
export interface RowDetail {
  id: string
  answers: Record<string, unknown>
  submittedAt: string
  source: string
  allowPostEdit?: number
  fields?: RowEditFieldMeta[]
  lastEdit?: { editorStaffId: string | null; editorName: string | null; editedAt: string } | null
}
export interface FormStats {
  total: number
  verified: number
  daily: { day: string; count: number }[]
  formaloo: unknown
}
export interface SavedFilter {
  id: string
  name: string
  filter: Record<string, unknown>
}
export interface RowsQuery {
  q?: string
  from?: string
  to?: string
  sort?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

function toQueryString(q: RowsQuery): string {
  const p = new URLSearchParams()
  if (q.q) p.set('q', q.q)
  if (q.from) p.set('from', q.from)
  if (q.to) p.set('to', q.to)
  if (q.sort) p.set('sort', q.sort)
  if (q.page) p.set('page', String(q.page))
  if (q.pageSize) p.set('pageSize', String(q.pageSize))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const formalooDataApi = {
  async rows(id: string, q: RowsQuery = {}): Promise<RowsPage> {
    return (await fetchApi<Envelope<RowsPage>>(`/api/forms-advanced/${id}/rows${toQueryString(q)}`)).data
  },
  async row(id: string, rowId: string): Promise<RowDetail> {
    return (await fetchApi<Envelope<RowDetail>>(`/api/forms-advanced/${id}/rows/${rowId}`)).data
  },
  /**
   * 弾M (form-post-edit / T-D1): ①管理者編集の保存。PATCH で編集後 answers を送る。
   * 反映されない編集は worker が正直エラー (非 2xx) を返す → fetchApi が throw = 呼び出し側で保存を止める。
   */
  async editRow(id: string, rowId: string, answers: Record<string, unknown>): Promise<RowEditResult> {
    return (await fetchApi<Envelope<RowEditResult>>(`/api/forms-advanced/${id}/rows/${rowId}`, { method: 'PATCH', body: JSON.stringify({ answers }) })).data
  },
  async stats(id: string): Promise<FormStats> {
    return (await fetchApi<Envelope<FormStats>>(`/api/forms-advanced/${id}/stats`)).data
  },
  async listFilters(id: string): Promise<SavedFilter[]> {
    return (await fetchApi<Envelope<SavedFilter[]>>(`/api/forms-advanced/${id}/filters`)).data
  },
  async saveFilter(id: string, name: string, filter: Record<string, unknown>): Promise<SavedFilter> {
    return (await fetchApi<Envelope<SavedFilter>>(`/api/forms-advanced/${id}/filters`, { method: 'POST', body: JSON.stringify({ name, filter }) })).data
  },
  async deleteFilter(id: string, filterId: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/forms-advanced/${id}/filters/${filterId}`, { method: 'DELETE' })
  },
  /** CSV 書き出し (owner gated)。fetchApi は blob 不可のため downloadCsv の専用 fetch 経路。 */
  async exportCsv(id: string, filename: string): Promise<void> {
    await downloadCsv(`/api/forms-advanced/${id}/export.csv`, filename)
  },
  async importCsv(id: string, csv: string): Promise<{ parsed: number; pushed: boolean; note: string }> {
    return (await fetchApi<Envelope<{ parsed: number; pushed: boolean; note: string }>>(`/api/forms-advanced/${id}/import`, { method: 'POST', body: JSON.stringify({ csv }) })).data
  },
  async bulkDelete(id: string, ids: string[]): Promise<{ deleted: number }> {
    return (await fetchApi<Envelope<{ deleted: number }>>(`/api/forms-advanced/${id}/rows/bulk-delete`, { method: 'POST', body: JSON.stringify({ ids }) })).data
  },
}
