import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manager = readFileSync(new URL('./sender-preset-manager.tsx', import.meta.url), 'utf8')

describe('sender preset icon upload contract', () => {
  it('uses the sender-icon purpose so the UI enforces the LINE PNG / 1MB / 1:1 contract', () => {
    expect(manager).toContain('usage="sender-icon"')
    expect(manager).toContain('mode="url"')
  })
})
