import type {} from 'pinia-plugin-synced'

import { defaultMaxSteps } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

export { defaultMaxSteps } from '@proj-airi/core-agent'

function loadEnabled(key: string) {
  // Non-renderer runtimes have no durable settings owner. They use the product
  // default until a synchronized renderer snapshot arrives.
  if (typeof localStorage === 'undefined')
    return false

  return localStorage.getItem(`settings/consciousness/${key}`) === 'true'
}

function loadMaxSteps() {
  if (typeof localStorage === 'undefined')
    return defaultMaxSteps

  // A missing or damaged value is not a positive integer, so it uses the default.
  const value = Number(localStorage.getItem('settings/consciousness/max-steps'))
  return Number.isInteger(value) && value > 0 ? value : defaultMaxSteps
}

function persist(key: string, value: boolean | number) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem(`settings/consciousness/${key}`, String(value))
}

/**
 * Stores request policies for the consciousness module.
 *
 * Consciousness chat request preparation reads this state before inference.
 * Each provider maps the reasoning value to its own request fields.
 * `useLLM().stream` sends `maxSteps` as the step budget of each reply.
 */
export const useConsciousnessSettingsStore = defineStore('consciousness-settings', () => {
  // Pinia owns live cross-window state. Only synchronized actions write the
  // durable value, so a follower cannot persist an uncommitted proposal.
  const reasoning = shallowRef(loadEnabled('reasoning'))
  const temperatureEnabled = shallowRef(loadEnabled('temperature-enabled'))
  const topPEnabled = shallowRef(loadEnabled('top-p-enabled'))
  const maxSteps = shallowRef(loadMaxSteps())

  async function setReasoning(value: boolean) {
    reasoning.value = value
    persist('reasoning', value)
  }

  async function setTemperatureEnabled(value: boolean) {
    temperatureEnabled.value = value
    persist('temperature-enabled', value)
  }

  async function setTopPEnabled(value: boolean) {
    topPEnabled.value = value
    persist('top-p-enabled', value)
  }

  async function setMaxSteps(value: number) {
    maxSteps.value = value
    persist('max-steps', value)
  }

  async function resetState() {
    await setReasoning(false)
    await setTemperatureEnabled(false)
    await setTopPEnabled(false)
    await setMaxSteps(defaultMaxSteps)
  }

  return {
    reasoning,
    temperatureEnabled,
    topPEnabled,
    maxSteps,
    setReasoning,
    setTemperatureEnabled,
    setTopPEnabled,
    setMaxSteps,
    resetState,
  }
}, {
  synced: {
    actions: ['resetState', 'setReasoning', 'setTemperatureEnabled', 'setTopPEnabled', 'setMaxSteps'],
    state: true,
  },
})
