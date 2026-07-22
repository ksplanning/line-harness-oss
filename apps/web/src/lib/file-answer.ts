export interface FileAnswerEntry {
  key: string
  name: string
  size?: number
  type?: string
}

const MAX_SUMMARY_LENGTH = 60

export function isFileAnswer(value: unknown): value is FileAnswerEntry[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => entry !== null
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && typeof (entry as { key?: unknown }).key === 'string'
      && typeof (entry as { name?: unknown }).name === 'string')
}

export function fileAnswerSummary(files: FileAnswerEntry[]): string {
  const names = files.map((file) => file.name || '添付ファイル')
  const joined = names.join(', ')
  if (names.length > 1 && joined.length > MAX_SUMMARY_LENGTH) {
    return `${names[0]} ほか${names.length - 1}件`
  }
  return joined
}

export function fileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
