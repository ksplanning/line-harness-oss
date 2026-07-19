import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { NAV_FEATURE, isNavVisible } from './nav-permissions'

describe('AI chat navigation', () => {
  test('adds the sidebar link under the existing forms_advanced permission', () => {
    const sidebar = readFileSync(new URL('../components/layout/sidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).toContain("{ href: '/ai-chat', label: 'AIチャット'")
    expect(NAV_FEATURE['/ai-chat']).toBe('forms_advanced')
    expect(isNavVisible('/ai-chat', { hasCustomRole: true, permissions: ['forms_advanced'] })).toBe(true)
    expect(isNavVisible('/ai-chat', { hasCustomRole: true, permissions: ['friend'] })).toBe(false)
  })
})
