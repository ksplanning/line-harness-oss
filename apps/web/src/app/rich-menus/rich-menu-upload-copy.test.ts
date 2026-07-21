import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('rich menu upload limit copy', () => {
  it('keeps 1MB and explicitly identifies it as the LINE official limit', () => {
    const source = readFileSync(new URL('./edit/page.tsx', import.meta.url), 'utf8')
    expect(source).toContain('1MB 以下')
    expect(source).toContain('LINE公式の上限')
  })
})
