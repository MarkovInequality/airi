import type {} from 'pinia-plugin-synced'

import { defaultMaxSteps } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

import * as v from 'valibot'

export { defaultMaxSteps } from '@proj-airi/core-agent'

/**
 * What AIRI assumes about image input of the chat model.
 *
 * - `auto`: the provider catalog decides. Most catalogs do not report image input.
 * - `supported`: the chat model gets images directly, and the vision model does not read them.
 * - `unsupported`: AIRI handles images as for a model without image input.
 */
export const imageInputSchema = v.picklist(['auto', 'supported', 'unsupported'])
export type ImageInput = v.InferOutput<typeof imageInputSchema>

/** Tool images that each chat request keeps until the user picks another number. */
export const defaultMaxToolImages = 2

function loadEnabled(key: string) {
  // Non-renderer runtimes have no durable settings owner. They use the product
  // default until a synchronized renderer snapshot arrives.
  if (typeof localStorage === 'undefined')
    return false

  return localStorage.getItem(`settings/consciousness/${key}`) === 'true'
}

function loadPositiveInteger(key: string, fallback: number) {
  if (typeof localStorage === 'undefined')
    return fallback

  // A missing or damaged value is not a positive integer, so it uses the default.
  const value = Number(localStorage.getItem(`settings/consciousness/${key}`))
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function loadImageInput(): ImageInput {
  if (typeof localStorage === 'undefined')
    return 'auto'

  // A missing or unknown value leaves the decision to the provider catalog.
  const value = localStorage.getItem('settings/consciousness/image-input')
  return v.is(imageInputSchema, value) ? value : 'auto'
}

function persist(key: string, value: boolean | number | string) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem(`settings/consciousness/${key}`, String(value))
}

/**
 * Stores request policies for the consciousness module.
 *
 * Consciousness chat request preparation reads this state before inference.
 * Each provider maps the reasoning value to its own request fields.
 * `useLLM().stream` sends `maxSteps` as the step budget of each reply, and
 * `maxToolImages` as the number of tool images that each request keeps.
 * `useChatVision` reads `imageInput` to decide which model reads images.
 */
export const useConsciousnessSettingsStore = defineStore('consciousness-settings', () => {
  // Pinia owns live cross-window state. Only synchronized actions write the
  // durable value, so a follower cannot persist an uncommitted proposal.
  const reasoning = shallowRef(loadEnabled('reasoning'))
  const temperatureEnabled = shallowRef(loadEnabled('temperature-enabled'))
  const topPEnabled = shallowRef(loadEnabled('top-p-enabled'))
  const maxSteps = shallowRef(loadPositiveInteger('max-steps', defaultMaxSteps))
  const imageInput = shallowRef(loadImageInput())
  const maxToolImages = shallowRef(loadPositiveInteger('max-tool-images', defaultMaxToolImages))

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

  async function setImageInput(value: ImageInput) {
    imageInput.value = value
    persist('image-input', value)
  }

  async function setMaxToolImages(value: number) {
    maxToolImages.value = value
    persist('max-tool-images', value)
  }

  async function resetState() {
    await setReasoning(false)
    await setTemperatureEnabled(false)
    await setTopPEnabled(false)
    await setMaxSteps(defaultMaxSteps)
    await setImageInput('auto')
    await setMaxToolImages(defaultMaxToolImages)
  }

  return {
    reasoning,
    temperatureEnabled,
    topPEnabled,
    maxSteps,
    imageInput,
    maxToolImages,
    setReasoning,
    setTemperatureEnabled,
    setTopPEnabled,
    setMaxSteps,
    setImageInput,
    setMaxToolImages,
    resetState,
  }
}, {
  synced: {
    actions: ['resetState', 'setReasoning', 'setTemperatureEnabled', 'setTopPEnabled', 'setMaxSteps', 'setImageInput', 'setMaxToolImages'],
    state: true,
  },
})
