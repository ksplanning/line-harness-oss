/**
 * HelpPopover の表示位置 (縦横の反転) を、トリガー矩形 / viewport / popover 寸法から決める純ロジック。
 *
 * - 横: 既定は left 基準 (トリガー左端揃え)。left 基準だと右にはみ出す (375px でトリガーが行の
 *   右寄りにある場合) なら right 基準へ反転し、popover 右端をトリガー右端に揃えて左へ展開する。
 * - 縦: 下端に近ければ above (上へ反転)、そうでなければ below (下へ出す) — 既存の flipUp 挙動を保持。
 *
 * jsdom を使わず決定的に検証できるよう UI から切り出す (browser-evaluator medium fold-in)。
 */
export const POPOVER_WIDTH = 256 // Tailwind w-64
export const POPOVER_HEIGHT = 320 // 画像(~256) + 見出し / 短文 / 閉じる の目安

export interface PopoverPlacement {
  horizontal: 'left' | 'right'
  vertical: 'above' | 'below'
}

export function popoverPlacement(
  anchor: { left: number; bottom: number },
  viewport: { width: number; height: number },
  popover: { width: number; height: number } = { width: POPOVER_WIDTH, height: POPOVER_HEIGHT },
  margin = 8,
): PopoverPlacement {
  const overflowsRight = viewport.width > 0 && anchor.left + popover.width > viewport.width - margin
  const overflowsBottom = viewport.height > 0 && anchor.bottom > viewport.height - popover.height
  return {
    horizontal: overflowsRight ? 'right' : 'left',
    vertical: overflowsBottom ? 'above' : 'below',
  }
}
