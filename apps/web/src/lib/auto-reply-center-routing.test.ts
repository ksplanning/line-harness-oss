import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isNavVisible, NAV_FEATURE } from './nav-permissions'

describe('自動応答センター routing / navigation contract', () => {
  it('旧3URLを、ブックマークの目的を保ったセンター内表示へ恒久redirectする', () => {
    const redirects = readFileSync(new URL('../../public/_redirects', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    expect(redirects).toContain('/auto-replies /auto-reply-center?view=rules 301')
    expect(redirects).toContain('/faqs /auto-reply-center?view=knowledge&source=faq 301')
    expect(redirects).toContain('/knowledge /auto-reply-center?view=knowledge&source=documents 301')
  })

  it('sidebarは旧3項目でなく「自動応答センター」1項目だけを示す', () => {
    const sidebar = readFileSync(new URL('../components/layout/sidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).toContain("{ href: '/auto-reply-center', label: '自動応答センター'")
    expect(sidebar).not.toContain("{ href: '/auto-replies', label: '自動返信ルール'")
    expect(sidebar).not.toContain("{ href: '/faqs', label: 'よくある質問（自動応答）'")
    expect(sidebar).not.toContain("{ href: '/knowledge', label: '資料・AIログ'")
  })

  it('faq または auto_reply のどちらかを持つcustom roleに統合導線を表示する', () => {
    expect(NAV_FEATURE['/auto-reply-center']).toEqual(['faq', 'auto_reply'])
    expect(isNavVisible('/auto-reply-center', { permissions: ['faq'], hasCustomRole: true })).toBe(true)
    expect(isNavVisible('/auto-reply-center', { permissions: ['auto_reply'], hasCustomRole: true })).toBe(true)
    expect(isNavVisible('/auto-reply-center', { permissions: ['chat'], hasCustomRole: true })).toBe(false)

    // 旧URLの権限mapは、センター内部のsection表示判定に引き続き使う。
    expect(NAV_FEATURE['/faqs']).toBe('faq')
    expect(NAV_FEATURE['/knowledge']).toBe('faq')
    expect(NAV_FEATURE['/auto-replies']).toBe('auto_reply')
  })
})
