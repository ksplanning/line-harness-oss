import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const uploader = readFileSync(new URL('../shared/image-uploader.tsx', import.meta.url), 'utf8')
const parts = readFileSync(new URL('./part-editor.tsx', import.meta.url), 'utf8')
const modal = readFileSync(new URL('./flex-builder-modal.tsx', import.meta.url), 'utf8')

describe('Flex media upload ceilings are explicit and purpose-scoped', () => {
  it('labels ordinary Flex images (10MB/recommended 1MB) and icons (1MB)', () => {
    expect(parts).toContain('usage="flex-image"')
    expect(parts).toContain('usage="flex-icon"')
    expect(uploader).toMatch(/Flex画像[^'\n]*10MB[^'\n]*1MB/)
    expect(uploader).toMatch(/Flexアイコン[^'\n]*1MB/)
    expect(uploader).toMatch(/Flex画像[^'\n]*1024/)
    expect(uploader).toMatch(/Flexアイコン[^'\n]*1024/)
  })

  it('separates the video preview 1MB ceiling from the Flex alt image 10MB ceiling', () => {
    expect(modal).toContain('LINE公式上限200MB')
    expect(modal.match(/usage="line-preview"/g)?.length).toBe(1)
    expect(modal).toMatch(/代わりの画像[\s\S]*usage="flex-image"/)
    expect(modal).toContain('プレビュー画像はJPEG / PNG・1MBまで')
    expect(modal).toContain('代替画像はFlex画像として10MBまで（実用上は1MB以下を推奨）')
    expect(uploader).toMatch(/プレビュー画像[^'\n]*1MB/)
  })
})
