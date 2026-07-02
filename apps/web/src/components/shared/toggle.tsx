'use client'

export default function Toggle({
  value,
  disabled = false,
  onClick,
}: {
  value: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        value ? 'bg-green-500' : 'bg-gray-300'
      } ${disabled ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
      aria-label={value ? '無効化' : '有効化'}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
          value ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
