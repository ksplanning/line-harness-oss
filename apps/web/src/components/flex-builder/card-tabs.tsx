'use client'

/**
 * カードタブ (F7 / ui-design §3)。カードが 2 枚以上のとき表示。
 * 「＋ カードを横に増やす」で複製 (bubble→carousel)。カードの左右移動・複製・削除。
 * 1 枚のときはタブを出さず「＋ カードを横に増やす」だけ (認知負荷ゼロ)。
 */
interface Props {
  cardCount: number
  activeIndex: number
  onSelect: (i: number) => void
  onDuplicate: () => void
  onMove: (dir: 'left' | 'right') => void
  onRemove: () => void
}

export default function CardTabs({
  cardCount,
  activeIndex,
  onSelect,
  onDuplicate,
  onMove,
  onRemove,
}: Props) {
  const isCarousel = cardCount >= 2

  return (
    <div className="space-y-2">
      {isCarousel && (
        <div className="flex flex-wrap items-center gap-1">
          {Array.from({ length: cardCount }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              className={`min-h-[36px] px-3 rounded-t-md border-b-2 text-sm ${
                i === activeIndex
                  ? 'border-green-500 text-green-700 font-medium'
                  : 'border-transparent text-gray-500'
              }`}
            >
              カード{i + 1}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onDuplicate}
          className="min-h-[36px] px-3 rounded-md border border-green-500 text-green-700 bg-green-50 text-sm hover:bg-green-100"
        >
          ＋ カードを横に増やす
        </button>
        {isCarousel && (
          <>
            <button
              type="button"
              onClick={() => onMove('left')}
              disabled={activeIndex === 0}
              className="min-h-[36px] px-3 rounded-md border border-gray-300 text-gray-600 text-sm disabled:opacity-30"
            >
              ◀ 左へ
            </button>
            <button
              type="button"
              onClick={() => onMove('right')}
              disabled={activeIndex === cardCount - 1}
              className="min-h-[36px] px-3 rounded-md border border-gray-300 text-gray-600 text-sm disabled:opacity-30"
            >
              右へ ▶
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="min-h-[36px] px-3 rounded-md border border-gray-300 text-gray-500 text-sm hover:text-red-600 hover:border-red-300"
            >
              🗑 このカードを消す
            </button>
          </>
        )}
      </div>
    </div>
  )
}
