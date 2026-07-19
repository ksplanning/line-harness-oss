'use client'

import type { HarnessField } from '@line-crm/shared'
import { isRepeatingColumnType } from './field-types'

interface StructuralFieldPanelProps {
  field: HarnessField
  allFields: HarnessField[]
  onChange: (field: HarnessField) => void
}

function itemTitles(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean)
}

function generatedColumnKey(index: number, usedKeys: ReadonlySet<string>): string {
  const base = `column_${index + 1}`
  if (!usedKeys.has(base)) return base

  let suffix = 2
  while (usedKeys.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

export default function StructuralFieldPanel({ field, allFields, onChange }: StructuralFieldPanelProps) {
  const cfg = field.config
  const set = (patch: Partial<HarnessField>) => onChange({ ...field, ...patch })
  const setCfg = (patch: Partial<HarnessField['config']>) => onChange({ ...field, config: { ...cfg, ...patch } })
  const scalarFields = allFields.filter((candidate) => candidate.id !== field.id && isRepeatingColumnType(candidate.type))

  const commonSettings = (
    <>
      <div>
        <label className="mb-1 block text-xs text-gray-500">ラベル</label>
        <input
          aria-label="ラベル"
          value={field.label}
          onChange={(event) => set({ label: event.target.value })}
          className="w-full rounded border border-gray-300 px-2 py-1"
        />
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="必須"
          checked={field.required}
          onChange={(event) => set({ required: event.target.checked })}
        />
        <span>必須項目にする</span>
      </label>
      <div>
        <label className="mb-1 block text-xs text-gray-500">補足説明</label>
        <textarea
          aria-label="補足説明"
          value={cfg.description ?? ''}
          onChange={(event) => setCfg({ description: event.target.value || undefined })}
          className="w-full rounded border border-gray-300 px-2 py-1"
        />
      </div>
    </>
  )

  if (field.type === 'matrix') {
    const groups = cfg.matrixChoiceGroups ?? []
    const itemEntries = Object.entries(cfg.matrixChoiceItems ?? {})

    return (
      <div className="space-y-3 text-sm" data-testid="settings-panel">
        {commonSettings}
        <div>
          <label className="mb-1 block text-xs text-gray-500">行（1行に1項目）</label>
          <textarea
            aria-label="行（1行に1項目）"
            rows={4}
            value={groups.map((group) => group.title).join('\n')}
            onChange={(event) => {
              const titles = itemTitles(event.target.value)
              setCfg({
                matrixChoiceGroups: titles.map((title, index) => ({
                  ...groups[index],
                  title,
                })),
              })
            }}
            className="w-full rounded border border-gray-300 px-2 py-1"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">列（1行に1項目）</label>
          <textarea
            aria-label="列（1行に1項目）"
            rows={4}
            value={itemEntries.map(([, item]) => item.title).join('\n')}
            onChange={(event) => {
              const titles = itemTitles(event.target.value)
              const usedKeys = new Set(itemEntries.map(([key]) => key))
              const nextItems: NonNullable<HarnessField['config']['matrixChoiceItems']> = {}

              titles.forEach((title, index) => {
                const current = itemEntries[index]
                const key = current?.[0] ?? generatedColumnKey(index, usedKeys)
                usedKeys.add(key)
                nextItems[key] = { ...current?.[1], title }
              })
              setCfg({ matrixChoiceItems: nextItems })
            }}
            className="w-full rounded border border-gray-300 px-2 py-1"
          />
        </div>
      </div>
    )
  }

  const columns = cfg.repeatingColumns ?? []
  const updateColumn = (index: number, patch: Partial<(typeof columns)[number]>) => {
    setCfg({ repeatingColumns: columns.map((column, current) => current === index ? { ...column, ...patch } : column) })
  }

  return (
    <div className="space-y-3 text-sm" data-testid="settings-panel">
      {commonSettings}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-xs text-gray-500">最小行数</label>
          <input
            type="number"
            min={0}
            max={32767}
            step={1}
            aria-label="最小行数"
            value={cfg.minRows ?? 1}
            onChange={(event) => setCfg({ minRows: Number(event.target.value) })}
            className="w-full rounded border border-gray-300 px-2 py-1"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">最大行数</label>
          <input
            type="number"
            min={0}
            max={32767}
            step={1}
            aria-label="最大行数"
            value={cfg.maxRows ?? 5}
            onChange={(event) => setCfg({ maxRows: Number(event.target.value) })}
            className="w-full rounded border border-gray-300 px-2 py-1"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-gray-500">繰り返す列</div>
        {columns.map((column, index) => {
          const currentField = allFields.find((candidate) => candidate.id === column.columnField)
          return (
            <div key={index} className="space-y-1 rounded border border-gray-200 p-2">
              <div>
                <label className="mb-1 block text-xs text-gray-500">項目</label>
                <select
                  aria-label={`繰り返し列${index + 1}の項目`}
                  value={column.columnField}
                  onChange={(event) => {
                    const nextField = scalarFields.find((candidate) => candidate.id === event.target.value)
                    const replaceDefaultTitle = !column.title || column.title === currentField?.label
                    updateColumn(index, {
                      columnField: event.target.value,
                      ...(replaceDefaultTitle && nextField ? { title: nextField.label } : {}),
                    })
                  }}
                  className="w-full rounded border border-gray-300 px-2 py-1"
                >
                  {!scalarFields.some((candidate) => candidate.id === column.columnField) && column.columnField ? (
                    <option value={column.columnField}>{column.title || column.columnField}</option>
                  ) : null}
                  {scalarFields.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">見出し</label>
                <input
                  aria-label={`繰り返し列${index + 1}の見出し`}
                  value={column.title}
                  onChange={(event) => updateColumn(index, { title: event.target.value })}
                  className="w-full rounded border border-gray-300 px-2 py-1"
                />
              </div>
              <button
                type="button"
                aria-label={`繰り返し列${index + 1}を削除`}
                disabled={columns.length <= 1}
                onClick={() => setCfg({ repeatingColumns: columns.filter((_, current) => current !== index) })}
                className="text-xs text-red-600 disabled:opacity-40"
              >
                列を削除
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        disabled={scalarFields.length === 0}
        onClick={() => {
          const candidate = scalarFields.find((item) => !columns.some((column) => column.columnField === item.id)) ?? scalarFields[0]
          if (!candidate) return
          setCfg({ repeatingColumns: [...columns, { columnField: candidate.id, title: candidate.label }] })
        }}
        className="text-xs disabled:opacity-40"
        style={{ color: '#06C755' }}
      >
        列を追加
      </button>
      {scalarFields.length === 0 ? (
        <p className="text-[10px] leading-snug text-amber-600">先に、繰り返す入力項目を追加してください。</p>
      ) : null}
    </div>
  )
}
