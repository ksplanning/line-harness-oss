'use client'

/**
 * ドラッグ式 ImageMap 領域エディタ (G65 / H-1)。ベース画像の上をなぞって四角 (押せる範囲) を
 * 描き、掴んで移動 / 角でリサイズ / 選んで飛び先を設定 / 削除できる。出力は broadcast-media の
 * MediaRegion 配列 (数値入力と同型) なので、数値モードと同じ s.regions に双方向接続できる。
 *
 * ドラッグ矩形のパターン (toImageCoord / create・move・resize の DragState) は実証済みの
 * rich-menus/canvas-editor.tsx を流用。差分 = (a) 座標空間がベース画像の baseW×baseH
 * (b) action は uri/message/clipboard (c) LINE imagemap の 50 area 上限。矩形の描画は % 指定で
 * レスポンシブ、ドラッグ計算のみ getBoundingClientRect を使う。
 */
import { useEffect, useRef, useState } from 'react'
import { num, type MediaRegion } from '@/lib/broadcast-media'
import { TrashIcon } from '@/components/shared/icons'

const MIN_AREA = 20 // 画像座標での最小矩形 (誤タップの極小領域を防ぐ)
const MAX_REGIONS = 50 // LINE imagemap の area 上限

type Rect = { x: number; y: number; width: number; height: number }

type DragState =
  | { mode: 'create'; startX: number; startY: number; curX: number; curY: number }
  | { mode: 'move'; index: number; original: Rect; startX: number; startY: number }
  | { mode: 'resize'; index: number; original: Rect; handle: string; startX: number; startY: number }
  | null

function rectOf(r: MediaRegion): Rect {
  return { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }
}
function overlaps(a: Rect, b: Rect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)
}

export default function ImagemapRegionEditor({
  imageUrl,
  baseW,
  baseH,
  regions,
  onChange,
}: {
  imageUrl: string
  baseW: number
  baseH: number
  regions: MediaRegion[]
  onChange: (regions: MediaRegion[]) => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const regionsRef = useRef(regions)
  regionsRef.current = regions
  const [drag, setDrag] = useState<DragState>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [limitHit, setLimitHit] = useState(false)

  const bw = baseW > 0 ? baseW : 1040
  const bh = baseH > 0 ? baseH : 1040

  // regions が縮んで選択 index が範囲外になったら選択解除。
  useEffect(() => {
    if (selected !== null && selected >= regions.length) setSelected(null)
  }, [regions.length, selected])

  function toImageCoord(clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const scale = rect.width > 0 ? rect.width / bw : 1
    return {
      x: Math.round((clientX - rect.left) / scale),
      y: Math.round((clientY - rect.top) / scale),
    }
  }
  const clampX = (x: number, w: number) => Math.max(0, Math.min(bw - w, x))
  const clampY = (y: number, h: number) => Math.max(0, Math.min(bh - h, y))

  function patchRect(index: number, rect: Rect) {
    onChange(
      regionsRef.current.map((r, i) =>
        i === index
          ? {
              ...r,
              x: String(Math.round(rect.x)),
              y: String(Math.round(rect.y)),
              width: String(Math.round(rect.width)),
              height: String(Math.round(rect.height)),
            }
          : r,
      ),
    )
  }

  // タッチ/ペンで指が要素外へ出てもドラッグを継続する (window リスナと二重の安全網)。
  // jsdom は setPointerCapture 未実装なので try/catch で握りつぶす (テストは window リスナ側で成立)。
  function capturePointer(e: React.PointerEvent) {
    try {
      canvasRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* 未対応環境 (jsdom 等) では no-op */
    }
  }

  function handleCanvasPointerDown(e: React.PointerEvent) {
    if (e.target !== canvasRef.current) return
    capturePointer(e)
    const { x, y } = toImageCoord(e.clientX, e.clientY)
    setDrag({ mode: 'create', startX: x, startY: y, curX: x, curY: y })
    setSelected(null)
  }
  function handleRegionPointerDown(e: React.PointerEvent, index: number) {
    e.stopPropagation()
    capturePointer(e)
    setSelected(index)
    const { x, y } = toImageCoord(e.clientX, e.clientY)
    setDrag({ mode: 'move', index, original: rectOf(regionsRef.current[index]), startX: x, startY: y })
  }
  function handleHandlePointerDown(e: React.PointerEvent, index: number, handle: string) {
    e.stopPropagation()
    capturePointer(e)
    const { x, y } = toImageCoord(e.clientX, e.clientY)
    setDrag({ mode: 'resize', index, original: rectOf(regionsRef.current[index]), handle, startX: x, startY: y })
  }

  useEffect(() => {
    if (!drag) return
    function onMove(e: PointerEvent) {
      const { x, y } = toImageCoord(e.clientX, e.clientY)
      if (drag!.mode === 'create') {
        setDrag({ ...drag!, curX: x, curY: y })
        return
      }
      if (drag!.mode === 'move') {
        const o = drag!.original
        patchRect(drag!.index, {
          ...o,
          x: clampX(o.x + (x - drag!.startX), o.width),
          y: clampY(o.y + (y - drag!.startY), o.height),
        })
        return
      }
      // resize
      const o = drag!.original
      const dx = x - drag!.startX
      const dy = y - drag!.startY
      let { x: rx, y: ry, width: rw, height: rh } = o
      if (drag!.handle.includes('e')) rw = Math.max(MIN_AREA, o.width + dx)
      if (drag!.handle.includes('s')) rh = Math.max(MIN_AREA, o.height + dy)
      if (drag!.handle.includes('w')) {
        rx = Math.min(o.x + o.width - MIN_AREA, o.x + dx)
        rw = o.x + o.width - rx
      }
      if (drag!.handle.includes('n')) {
        ry = Math.min(o.y + o.height - MIN_AREA, o.y + dy)
        rh = o.y + o.height - ry
      }
      rx = clampX(rx, rw)
      ry = clampY(ry, rh)
      rw = Math.min(bw - rx, rw)
      rh = Math.min(bh - ry, rh)
      patchRect(drag!.index, { x: rx, y: ry, width: rw, height: rh })
    }
    function onUp(e: PointerEvent) {
      if (drag!.mode === 'create') {
        // 端ドラッグで画像外に出た終点を境界内へ clamp してから矩形化する。始点は canvas 内の
        // pointerdown 由来で既に境界内なので、clampX/clampY を幅0で使い「点」を [0,bw]/[0,bh] に
        // 収める (座標 clamp の単一正典を再利用 = 幅を別途 clamp する二重実装を足さない)。これで
        // nx=min(始点,終点) / w=|終点-始点| は必ず x+width<=bw を満たし、端ドラッグは全幅化せず帯に収まる。
        const end = toImageCoord(e.clientX, e.clientY)
        const ex = clampX(end.x, 0)
        const ey = clampY(end.y, 0)
        const w = Math.abs(ex - drag!.startX)
        const h = Math.abs(ey - drag!.startY)
        if (w >= MIN_AREA && h >= MIN_AREA) {
          if (regionsRef.current.length >= MAX_REGIONS) {
            setLimitHit(true)
          } else {
            const nx = Math.min(drag!.startX, ex)
            const ny = Math.min(drag!.startY, ey)
            const next: MediaRegion = { x: String(nx), y: String(ny), width: String(w), height: String(h), actionType: 'uri', value: '' }
            const idx = regionsRef.current.length
            onChange([...regionsRef.current, next])
            setSelected(idx)
            setLimitHit(false)
          }
        }
      }
      setDrag(null)
    }
    // タッチ中断 (通知割込み・多点タッチ等) はコミットせず drag を破棄する (stuck 防止)。
    function onCancel() {
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    // drag のみ deps: regions は regionsRef で最新参照 (ドラッグ中の再アタッチを避ける)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag])

  function updateSelected(patch: Partial<MediaRegion>) {
    if (selected === null) return
    onChange(regions.map((r, i) => (i === selected ? { ...r, ...patch } : r)))
  }
  function deleteSelected() {
    if (selected === null) return
    onChange(regions.filter((_, i) => i !== selected))
    setSelected(null)
  }

  const sel = selected !== null ? regions[selected] : null

  return (
    <div className="space-y-2 select-none">
      <div
        className="relative w-full overflow-hidden rounded-lg border border-gray-300 bg-gray-100"
        style={{ aspectRatio: `${bw} / ${bh}` }}
      >
        <div
          ref={canvasRef}
          data-testid="imagemap-canvas"
          onPointerDown={handleCanvasPointerDown}
          className="absolute inset-0"
          style={{ cursor: 'crosshair', touchAction: 'none' }}
        >
          {imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="" className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
          )}
          {regions.map((r, i) => {
            const rect = rectOf(r)
            const isSel = i === selected
            const isOver = regions.some((o, j) => j !== i && overlaps(rect, rectOf(o)))
            return (
              <div
                key={i}
                data-testid={`region-${i}`}
                onPointerDown={(e) => handleRegionPointerDown(e, i)}
                className="absolute"
                style={{
                  left: `${(rect.x / bw) * 100}%`,
                  top: `${(rect.y / bh) * 100}%`,
                  width: `${(rect.width / bw) * 100}%`,
                  height: `${(rect.height / bh) * 100}%`,
                  border: `2px solid ${isOver ? '#dc2626' : isSel ? '#059669' : '#3b82f6'}`,
                  background: isSel ? 'rgba(5,150,105,0.18)' : 'rgba(59,130,246,0.12)',
                  cursor: 'move',
                  boxSizing: 'border-box',
                }}
              >
                <span className="absolute top-0 left-0 bg-white/85 text-[10px] leading-none px-1 py-0.5 text-gray-700 pointer-events-none">
                  {i + 1}
                </span>
                {isSel &&
                  ['nw', 'ne', 'sw', 'se'].map((h) => (
                    <div
                      key={h}
                      data-testid={`handle-${i}-${h}`}
                      onPointerDown={(e) => handleHandlePointerDown(e, i, h)}
                      className="absolute w-3 h-3 bg-green-600 rounded-sm"
                      style={handlePos(h)}
                    />
                  ))}
              </div>
            )
          })}
          {drag?.mode === 'create' &&
            (() => {
              const x = Math.min(drag.startX, drag.curX)
              const y = Math.min(drag.startY, drag.curY)
              const w = Math.abs(drag.curX - drag.startX)
              const h = Math.abs(drag.curY - drag.startY)
              if (w <= 0 || h <= 0) return null
              return (
                <div
                  className="absolute pointer-events-none border-2 border-dashed border-green-600"
                  style={{
                    left: `${(x / bw) * 100}%`,
                    top: `${(y / bh) * 100}%`,
                    width: `${(w / bw) * 100}%`,
                    height: `${(h / bh) * 100}%`,
                    background: 'rgba(5,150,105,0.10)',
                  }}
                />
              )
            })()}
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>画像の上をなぞって四角を描く／四角を押して選ぶ・動かす</span>
        <span className={regions.length >= MAX_REGIONS ? 'text-red-600 font-medium' : ''}>
          {regions.length} / {MAX_REGIONS}
        </span>
      </div>
      {limitHit && <p className="text-[11px] text-red-600">領域は最大 {MAX_REGIONS} 個までです（LINE の仕様）。</p>}

      {sel && (
        <div className="border border-green-200 bg-green-50/60 rounded-lg p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-700">選んだ領域 {selected! + 1} の飛び先</span>
            <button
              type="button"
              aria-label="この領域を削除"
              onClick={deleteSelected}
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-600 min-h-[36px] px-2"
            >
              <TrashIcon className="w-4 h-4" />削除
            </button>
          </div>
          <div className="flex gap-1.5 items-center">
            <select
              aria-label="飛び先の種類"
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
              value={sel.actionType}
              onChange={(e) => updateSelected({ actionType: e.target.value as MediaRegion['actionType'] })}
            >
              <option value="uri">リンク</option>
              <option value="message">テキスト応答</option>
              <option value="clipboard">クリップボードへコピー</option>
            </select>
            <input
              type="text"
              maxLength={sel.actionType === 'message' ? 400 : 1000}
              aria-label="飛び先や送る言葉"
              className="flex-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder={sel.actionType === 'uri' ? '飛び先 (http / https / line / tel)' : sel.actionType === 'message' ? '送るテキスト' : 'コピーするテキスト'}
              value={sel.value}
              onChange={(e) => updateSelected({ value: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function handlePos(h: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    nw: { left: -6, top: -6, cursor: 'nwse-resize' },
    ne: { right: -6, top: -6, cursor: 'nesw-resize' },
    sw: { left: -6, bottom: -6, cursor: 'nesw-resize' },
    se: { right: -6, bottom: -6, cursor: 'nwse-resize' },
  }
  return map[h]
}
