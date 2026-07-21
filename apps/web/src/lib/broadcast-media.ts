/**
 * broadcast 新メッセージ種別 (動画/音声/リッチメッセージ/リッチビデオ) の純ロジック。
 * React に依存しない (node 環境の vitest で単体テストできる)。UI は broadcast-media-inputs.tsx、
 * 保存時 client 検証は broadcast-form.tsx から本モジュールを使う。server が検証の正典。
 */

export type MediaMessageType = 'video' | 'audio' | 'imagemap' | 'richvideo'

export interface MediaRegion {
  x: string
  y: string
  width: string
  height: string
  actionType: 'uri' | 'message' | 'clipboard'
  value: string
  /** Existing official fields (for example label) retained across visual edits. */
  rawAction?: Record<string, unknown>
}

export interface MediaState {
  videoUrl: string
  previewUrl: string
  audioUrl: string
  durationSec: string
  baseUrl: string
  baseW: string
  baseH: string
  regions: MediaRegion[]
  btnLabel: string
  btnLink: string
  /** Parsed payload retained so fields not represented by the form survive edits. */
  rawRoot?: Record<string, unknown>
}

export const initialMediaState: MediaState = {
  videoUrl: '', previewUrl: '', audioUrl: '', durationSec: '',
  baseUrl: '', baseW: '1040', baseH: '1040', regions: [], btnLabel: '', btnLink: '',
}

export function num(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function isHttps(v: unknown): boolean {
  return typeof v === 'string' && v.length <= 2000 && /^https:\/\/\S+$/.test(v)
}

function isImagemapLink(v: unknown): boolean {
  return typeof v === 'string' && v.length <= 1000 && /^(?:https?|line|tel):\S+$/.test(v)
}

/**
 * imagemap 領域をベース画像 (baseW×baseH) の内側に収める。負値は 0、幅/高さは
 * 残り領域を超えない整数に丸める。ドラッグエディタ / 数値入力どちらの出力でも本番 LINE
 * payload が baseSize を必ず満たすことを保証する単一の座標正典 (§2-2 / failure_observable
 * 「本番で領域がズレる」の構造対策)。baseW/baseH<=0 (未入力) の軸は clamp しない (0 幅化を防ぐ)。
 */
export function clampRegion(r: MediaRegion, baseW: number, baseH: number): MediaRegion {
  let x = Math.max(0, Math.round(num(r.x)))
  let y = Math.max(0, Math.round(num(r.y)))
  let w = Math.max(0, Math.round(num(r.width)))
  let h = Math.max(0, Math.round(num(r.height)))
  if (baseW > 0) { x = Math.min(x, baseW); w = Math.min(w, baseW - x) }
  if (baseH > 0) { y = Math.min(y, baseH); h = Math.min(h, baseH - y) }
  return { ...r, x: String(x), y: String(y), width: String(w), height: String(h) }
}

/** 現在の種別に応じた messageContent JSON を組み立てる。必須未入力でも部分 JSON を返す (最終検証は保存時)。 */
export function buildMediaJson(type: MediaMessageType, s: MediaState): string {
  if (type === 'video') {
    if (!s.videoUrl && !s.previewUrl) return ''
    return JSON.stringify({ originalContentUrl: s.videoUrl, previewImageUrl: s.previewUrl })
  }
  if (type === 'audio') {
    if (!s.audioUrl && !s.durationSec) return ''
    return JSON.stringify({ originalContentUrl: s.audioUrl, duration: Math.round(num(s.durationSec) * 1000) })
  }
  if (type === 'imagemap') {
    if (!s.baseUrl && s.regions.length === 0) return ''
    const enteredWidth = num(s.baseW), bw = 1040, bh = num(s.baseH)
    return JSON.stringify({
      ...(s.rawRoot ?? {}),
      baseUrl: s.baseUrl,
      altText: typeof s.rawRoot?.altText === 'string' ? s.rawRoot.altText : 'リッチメッセージ',
      baseSize: { width: bw, height: bh },
      actions: s.regions.map((r0) => {
        // Existing pure callers may still supply another editing canvas width, but
        // LINE payloads always declare the official 1040px base width.
        const r = clampRegion(r0, enteredWidth, bh)
        const area = { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }
        const { linkUri: _linkUri, text: _text, clipboardText: _clipboardText, area: _area, type: _type, ...extras } = r.rawAction ?? {}
        return r.actionType === 'uri'
          ? { ...extras, type: 'uri', linkUri: r.value, area }
          : r.actionType === 'message'
            ? { ...extras, type: 'message', text: r.value, area }
            : { ...extras, type: 'clipboard', clipboardText: r.value, area }
      }),
    })
  }
  // richvideo: imagemap + video (再生後アクションボタン)。
  // baseUrl は /240〜/1040 の5サイズ用、previewImageUrl は1MB以下の単一画像で別物。
  if (!s.videoUrl && !s.previewUrl) return ''
  const w = 1040, h = num(s.baseH)
  const rawVideo = s.rawRoot?.video
  const preservedVideo = rawVideo && typeof rawVideo === 'object' && !Array.isArray(rawVideo)
    ? rawVideo as Record<string, unknown>
    : {}
  return JSON.stringify({
    ...(s.rawRoot ?? {}),
    baseUrl: s.baseUrl,
    altText: typeof s.rawRoot?.altText === 'string' ? s.rawRoot.altText : '動画メッセージ',
    baseSize: { width: w, height: h },
    actions: Array.isArray(s.rawRoot?.actions) ? s.rawRoot.actions : [],
    video: {
      ...preservedVideo,
      originalContentUrl: s.videoUrl,
      previewImageUrl: s.previewUrl,
      area: { x: 0, y: 0, width: w, height: h },
      externalLink: s.btnLabel || s.btnLink ? { linkUri: s.btnLink, label: s.btnLabel } : undefined,
    },
  })
}

/** 新 type の client 側検証 (即時フィードバック・server が正典)。OK なら null、不正なら日本語エラー。 */
export function validateMediaClient(type: MediaMessageType, content: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content || '{}') as unknown
  } catch {
    return 'メッセージ内容の形式が正しくありません'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'メッセージ内容の形式が正しくありません'
  const p = parsed as Record<string, unknown>
  if (type === 'video') {
    if (!isHttps(p.originalContentUrl) || !isHttps(p.previewImageUrl)) return '動画URLとプレビュー画像URLは https で入力してください'
  } else if (type === 'audio') {
    if (!isHttps(p.originalContentUrl)) return '音声URLは https で入力してください'
    if (typeof p.duration !== 'number' || p.duration <= 0) return '再生時間は正の数で入力してください'
  } else if (type === 'imagemap') {
    if (!isHttps(p.baseUrl)) return 'ベース画像URLは https で入力してください'
    const baseSize = p.baseSize as Record<string, unknown> | undefined
    if (!baseSize || baseSize.width !== 1040) return 'ベース画像の横幅は1040pxにしてください'
    const acts = p.actions as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(acts) || acts.length === 0) return '領域を1つ以上追加してください'
    for (const action of acts) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) return '領域の形式が正しくありません'
      const a = action as Record<string, unknown>
      if (a.type === 'uri' && typeof a.linkUri === 'string' && a.linkUri.length > 1000) {
        return '領域のリンク先は1000文字以内で入力してください'
      }
      if (a.type === 'uri' && !isImagemapLink(a.linkUri)) {
        return '領域のリンク先は http / https / line / tel で入力してください'
      }
      if (a.type === 'message' && (typeof a.text !== 'string' || a.text.length < 1 || a.text.length > 400)) {
        return '領域から送るテキストは1〜400文字で入力してください'
      }
      if (a.type === 'clipboard' && (typeof a.clipboardText !== 'string' || a.clipboardText.length < 1 || a.clipboardText.length > 1000)) {
        return '領域からコピーするテキストは1〜1000文字で入力してください'
      }
    }
  } else {
    if (!isHttps(p.baseUrl)) return 'ベース画像URLは https で入力してください'
    const baseSize = p.baseSize as Record<string, unknown> | undefined
    if (!baseSize || baseSize.width !== 1040 || typeof baseSize.height !== 'number' || baseSize.height <= 0) {
      return 'ベース画像の横幅は1040px、高さは正の数にしてください'
    }
    const v = p.video as Record<string, unknown> | undefined
    if (!v || !isHttps(v.originalContentUrl) || !isHttps(v.previewImageUrl)) return '動画URLとプレビュー画像URLは https で入力してください'
    const link = v.externalLink as Record<string, unknown> | undefined
    if (link && (link.linkUri || link.label)) {
      if (typeof link.label !== 'string' || link.label.length < 1 || link.label.length > 30) {
        return 'ボタンの文字は1〜30文字で入力してください'
      }
      if (typeof link.linkUri === 'string' && link.linkUri.length > 1000) {
        return 'ボタンの飛び先は1000文字以内で入力してください'
      }
      if (!isImagemapLink(link.linkUri)) {
        return 'ボタンの飛び先は http / https / line / tel で入力してください'
      }
    }
  }
  return null
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function numStr(v: unknown): string { return typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '0' }

/**
 * 保存済み messageContent (JSON) を編集 state (MediaState) に逆変換する (再編集経路 / Codex HIGH-5)。
 * buildMediaJson の逆写像で、buildMediaJson(parseMediaJson(json)) が元 JSON に戻る round-trip を保つ。
 * 空文字 / 壊れた JSON は初期 state を返す fail-safe (保存が壊れない)。server が検証の正典。
 */
export function parseMediaJson(type: MediaMessageType, content: string): MediaState {
  const base = { ...initialMediaState }
  if (!content || !content.trim()) return base
  let p: Record<string, unknown>
  try {
    p = JSON.parse(content) as Record<string, unknown>
  } catch {
    return base
  }
  if (type === 'video') {
    return { ...base, videoUrl: str(p.originalContentUrl), previewUrl: str(p.previewImageUrl) }
  }
  if (type === 'audio') {
    const durationMs = typeof p.duration === 'number' ? p.duration : 0
    return { ...base, audioUrl: str(p.originalContentUrl), durationSec: durationMs ? String(durationMs / 1000) : '' }
  }
  if (type === 'imagemap') {
    const bs = p.baseSize as { width?: unknown; height?: unknown } | undefined
    const acts = Array.isArray(p.actions) ? (p.actions as Array<Record<string, unknown>>) : []
    return {
      ...base,
      rawRoot: p,
      baseUrl: str(p.baseUrl),
      baseW: '1040',
      baseH: bs && typeof bs.height === 'number' ? String(bs.height) : base.baseH,
      regions: acts.map((a) => {
        const area = (a.area ?? {}) as Record<string, unknown>
        const actionType: MediaRegion['actionType'] = a.type === 'message'
          ? 'message'
          : a.type === 'clipboard'
            ? 'clipboard'
            : 'uri'
        const hasExtraFields = Object.keys(a).some((key) => !['type', 'linkUri', 'text', 'clipboardText', 'area'].includes(key))
        return {
          x: numStr(area.x), y: numStr(area.y), width: numStr(area.width), height: numStr(area.height),
          actionType,
          value: actionType === 'uri' ? str(a.linkUri) : actionType === 'message' ? str(a.text) : str(a.clipboardText),
          ...(actionType === 'clipboard' || hasExtraFields ? { rawAction: a } : {}),
        }
      }),
    }
  }
  // richvideo: 5サイズ用 baseUrl と単一 previewImageUrl を別々復元。
  const v = (p.video ?? {}) as Record<string, unknown>
  const bs = p.baseSize as { width?: unknown; height?: unknown } | undefined
  const link = (v.externalLink ?? {}) as Record<string, unknown>
  return {
    ...base,
    rawRoot: p,
    baseUrl: str(p.baseUrl),
    videoUrl: str(v.originalContentUrl),
    previewUrl: str(v.previewImageUrl),
    baseW: bs && typeof bs.width === 'number' ? String(bs.width) : base.baseW,
    baseH: bs && typeof bs.height === 'number' ? String(bs.height) : base.baseH,
    btnLabel: str(link.label),
    btnLink: str(link.linkUri),
  }
}
