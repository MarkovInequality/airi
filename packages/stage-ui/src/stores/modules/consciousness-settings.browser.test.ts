import type { LeadershipMode, SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { defaultMaxSteps, useConsciousnessSettingsStore } from './consciousness-settings'

const syncedContexts: Array<{
  pinia: ReturnType<typeof createPinia>
  runtime: SyncedPiniaRuntime
}> = []

function createSyncedContext(namespace: string, leadership: LeadershipMode) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({
    callTimeout: 1000,
    leadership,
    namespace,
  })
  pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  syncedContexts.push({ pinia, runtime })
  return { pinia, runtime }
}

describe('consciousness settings synchronization', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    for (const context of syncedContexts.splice(0)) {
      context.runtime.dispose()
      disposePinia(context.pinia)
    }
    localStorage.clear()
  })

  it.each(['reasoning', 'temperatureEnabled', 'topPEnabled'] as const)('applies a remote %s snapshot without publishing it again', async (field) => {
    const namespace = `consciousness-settings:${crypto.randomUUID()}`
    const leaderContext = createSyncedContext(namespace, 'leader-only')
    await vi.waitFor(() => expect(leaderContext.runtime.isLeader()).toBe(true))

    setActivePinia(leaderContext.pinia)
    const leaderStore = useConsciousnessSettingsStore()

    const followerContext = createSyncedContext(namespace, 'follower-only')
    setActivePinia(followerContext.pinia)
    const followerStore = useConsciousnessSettingsStore()
    await vi.waitFor(() => expect(followerContext.runtime.getLeaderId()).toBe(leaderContext.runtime.participantId))

    let leaderMutations = 0
    let followerMutations = 0
    let followerActions = 0
    leaderStore.$subscribe(() => leaderMutations++, { flush: 'sync' })
    followerStore.$subscribe(() => followerMutations++, { flush: 'sync' })
    followerStore.$onAction(() => followerActions++)

    leaderStore[field] = true
    await vi.waitFor(() => expect(followerStore[field]).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(leaderMutations).toBe(1)
    expect(followerMutations).toBe(1)
    expect(followerActions).toBe(0)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBeNull()
    expect(localStorage.getItem('settings/consciousness/temperature-enabled')).toBeNull()
    expect(localStorage.getItem('settings/consciousness/top-p-enabled')).toBeNull()
  })

  it.each([
    { field: 'maxSteps', value: 50 },
    { field: 'imageInput', value: 'supported' },
    { field: 'maxToolImages', value: 5 },
  ] as const)('applies a remote $field snapshot without publishing it again', async ({ field, value }) => {
    const namespace = `consciousness-settings:${crypto.randomUUID()}`
    const leaderContext = createSyncedContext(namespace, 'leader-only')
    await vi.waitFor(() => expect(leaderContext.runtime.isLeader()).toBe(true))

    setActivePinia(leaderContext.pinia)
    const leaderStore = useConsciousnessSettingsStore()

    const followerContext = createSyncedContext(namespace, 'follower-only')
    setActivePinia(followerContext.pinia)
    const followerStore = useConsciousnessSettingsStore()
    await vi.waitFor(() => expect(followerContext.runtime.getLeaderId()).toBe(leaderContext.runtime.participantId))

    let leaderMutations = 0
    let followerMutations = 0
    let followerActions = 0
    leaderStore.$subscribe(() => leaderMutations++, { flush: 'sync' })
    followerStore.$subscribe(() => followerMutations++, { flush: 'sync' })
    followerStore.$onAction(() => followerActions++)

    // Each case assigns one field, so the value type matches that field.
    Object.assign(leaderStore, { [field]: value })
    await vi.waitFor(() => expect(followerStore[field]).toBe(value))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(leaderMutations).toBe(1)
    expect(followerMutations).toBe(1)
    expect(followerActions).toBe(0)
    expect(localStorage.length).toBe(0)
  })

  it('persists a follower update through one leader-owned action', async () => {
    const namespace = `consciousness-settings:${crypto.randomUUID()}`
    const leaderContext = createSyncedContext(namespace, 'leader-only')
    await vi.waitFor(() => expect(leaderContext.runtime.isLeader()).toBe(true))

    setActivePinia(leaderContext.pinia)
    const leaderStore = useConsciousnessSettingsStore()

    const followerContext = createSyncedContext(namespace, 'follower-only')
    setActivePinia(followerContext.pinia)
    const followerStore = useConsciousnessSettingsStore()
    await vi.waitFor(() => expect(followerContext.runtime.getLeaderId()).toBe(leaderContext.runtime.participantId))

    let leaderActions = 0
    leaderStore.$onAction(({ name }) => {
      if (name === 'setReasoning')
        leaderActions++
    })

    await followerStore.setReasoning(true)
    await vi.waitFor(() => expect(followerStore.reasoning).toBe(true))

    expect(leaderStore.reasoning).toBe(true)
    expect(leaderActions).toBe(1)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBe('true')

    await followerStore.setTemperatureEnabled(true)
    await followerStore.setTopPEnabled(true)
    await vi.waitFor(() => expect(followerStore.temperatureEnabled).toBe(true))
    await vi.waitFor(() => expect(followerStore.topPEnabled).toBe(true))
    expect(leaderStore.temperatureEnabled).toBe(true)
    expect(leaderStore.topPEnabled).toBe(true)
    expect(localStorage.getItem('settings/consciousness/temperature-enabled')).toBe('true')
    expect(localStorage.getItem('settings/consciousness/top-p-enabled')).toBe('true')

    await followerStore.setMaxSteps(50)
    await vi.waitFor(() => expect(followerStore.maxSteps).toBe(50))
    expect(leaderStore.maxSteps).toBe(50)
    expect(localStorage.getItem('settings/consciousness/max-steps')).toBe('50')

    await followerStore.setImageInput('supported')
    await followerStore.setMaxToolImages(5)
    await vi.waitFor(() => expect(followerStore.imageInput).toBe('supported'))
    await vi.waitFor(() => expect(followerStore.maxToolImages).toBe(5))
    expect(leaderStore.imageInput).toBe('supported')
    expect(leaderStore.maxToolImages).toBe(5)
    expect(localStorage.getItem('settings/consciousness/image-input')).toBe('supported')
    expect(localStorage.getItem('settings/consciousness/max-tool-images')).toBe('5')

    await followerStore.resetState()
    await vi.waitFor(() => expect(followerStore.maxSteps).toBe(defaultMaxSteps))
    expect(leaderStore.maxSteps).toBe(defaultMaxSteps)
    await vi.waitFor(() => expect(followerStore.temperatureEnabled).toBe(false))
    await vi.waitFor(() => expect(followerStore.topPEnabled).toBe(false))
    expect(leaderStore.temperatureEnabled).toBe(false)
    expect(leaderStore.topPEnabled).toBe(false)
    expect(localStorage.getItem('settings/consciousness/temperature-enabled')).toBe('false')
    expect(localStorage.getItem('settings/consciousness/top-p-enabled')).toBe('false')
  })
})
