import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type SurfaceExpectation = {
  path: string
  editors: number
  mode?: 'emoji-only' | 'variables-and-emoji'
}

const surfaces: SurfaceExpectation[] = [
  { path: 'src/components/broadcasts/message-block-editor.tsx', editors: 1, mode: 'emoji-only' },
  { path: 'src/components/broadcasts/broadcast-media-inputs.tsx', editors: 1, mode: 'emoji-only' },
  { path: 'src/app/template-packs/page.tsx', editors: 1, mode: 'emoji-only' },
  { path: 'src/app/templates/page.tsx', editors: 2, mode: 'variables-and-emoji' },
  { path: 'src/components/canned-responses/canned-response-modal.tsx', editors: 1, mode: 'emoji-only' },
  { path: 'src/components/faqs/edit-dialog.tsx', editors: 1, mode: 'emoji-only' },
  { path: 'src/app/faqs/page.tsx', editors: 2, mode: 'emoji-only' },
  { path: 'src/app/reminders/page.tsx', editors: 1, mode: 'emoji-only' },
  { path: 'src/components/accounts/response-schedule-modal.tsx', editors: 1, mode: 'emoji-only' },
  { path: 'src/app/chats/page.tsx', editors: 2, mode: 'emoji-only' },
  { path: 'src/components/flex-builder/part-editor.tsx', editors: 3 },
  { path: 'src/components/auto-replies/edit-dialog.tsx', editors: 1, mode: 'variables-and-emoji' },
  { path: 'src/app/scenarios/detail/scenario-detail-client.tsx', editors: 1, mode: 'variables-and-emoji' },
]

describe('利用者へ届く文章を書く欄の絵文字ピッカー展開', () => {
  for (const surface of surfaces) {
    it(`${surface.path} は必要な editor を ${surface.editors} 箇所以上使う`, () => {
      const source = readFileSync(join(process.cwd(), surface.path), 'utf8')
      const editors = source.match(/<PersonalizedTextEditor\b/g) ?? []

      expect(editors.length).toBeGreaterThanOrEqual(surface.editors)
      if (surface.mode) {
        const modes = source.match(new RegExp(`mode=["']${surface.mode}["']`, 'g')) ?? []
        expect(modes.length).toBeGreaterThanOrEqual(surface.editors)
      }
    })
  }

  it('Flex の文章欄は利用画面から変数対応モードを選べる', () => {
    const modal = readFileSync(join(process.cwd(), 'src/components/flex-builder/flex-builder-modal.tsx'), 'utf8')
    const partEditor = readFileSync(join(process.cwd(), 'src/components/flex-builder/part-editor.tsx'), 'utf8')
    const scenario = readFileSync(join(process.cwd(), 'src/app/scenarios/detail/scenario-detail-client.tsx'), 'utf8')
    const templates = readFileSync(join(process.cwd(), 'src/app/templates/page.tsx'), 'utf8')

    expect(modal).toContain('textEditorMode')
    expect(partEditor).toContain('textEditorMode')
    expect(scenario).toContain('textEditorMode="variables-and-emoji"')
    expect(templates).toContain('textEditorMode="variables-and-emoji"')
  })

  it('チャットの2入力欄は共通editor内でも横幅いっぱいを保ち、ピッカーを上向きに開く', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/chats/page.tsx'), 'utf8')

    expect((source.match(/className=["']w-full\b/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((source.match(/pickerPlacement=["']above["']/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
