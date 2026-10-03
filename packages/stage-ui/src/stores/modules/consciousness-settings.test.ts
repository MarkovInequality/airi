// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { defaultMaxSteps, useConsciousnessSettingsStore } from './consciousness-settings'

describe('consciousness settings store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('turns model reasoning off by default', () => {
    const store = useConsciousnessSettingsStore()

    expect(store.reasoning).toBe(false)
  })

  it('loads the persisted value', () => {
    localStorage.setItem('settings/consciousness/reasoning', 'true')
    const store = useConsciousnessSettingsStore()

    expect(store.reasoning).toBe(true)
  })

  it('loads a persisted step budget', () => {
    localStorage.setItem('settings/consciousness/max-steps', '50')
    const store = useConsciousnessSettingsStore()

    expect(store.maxSteps).toBe(50)
  })

  it.each(['', 'many', '2.5', '-3'])('uses the default step budget when the persisted value is %j', (value) => {
    localStorage.setItem('settings/consciousness/max-steps', value)
    const store = useConsciousnessSettingsStore()

    expect(store.maxSteps).toBe(defaultMaxSteps)
  })

  it('persists changes through store actions', async () => {
    const store = useConsciousnessSettingsStore()
    await store.setReasoning(true)
    await store.setMaxSteps(50)

    expect(store.reasoning).toBe(true)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBe('true')
    expect(store.maxSteps).toBe(50)
    expect(localStorage.getItem('settings/consciousness/max-steps')).toBe('50')

    await store.resetState()

    expect(store.reasoning).toBe(false)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBe('false')
    expect(store.maxSteps).toBe(defaultMaxSteps)
    expect(localStorage.getItem('settings/consciousness/max-steps')).toBe(String(defaultMaxSteps))
  })

  it('ignores storage events because Pinia owns cross-window synchronization', () => {
    const store = useConsciousnessSettingsStore()

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'settings/consciousness/reasoning',
      newValue: 'true',
    }))

    expect(store.reasoning).toBe(false)
  })
})
