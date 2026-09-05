import type {} from 'pinia-plugin-synced'

import type { InferenceServiceProvider, ProviderValidationStatus } from '../../libs/providers/types'

import { useMutation, useQuery } from '@pinia/colada'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { client } from '../../composables/api'
import { getDefinedProvider } from '../../libs/providers'
import { inferenceServiceProvidersService as service } from '../../services/inference-service-providers'

const PROVIDERS_QUERY_KEY = ['inference-service-providers']
const providerStorageOptions = {
  // pinia-plugin-synced is the only cross-window propagation channel for this
  // store. Listening to storage events would feed replicated state back into
  // the leader as a new state proposal.
  listenToStorageChanges: false,
} as const

/**
 * Creates the remote provider-list query.
 *
 * The query returns a remote snapshot. The Provider Config Store merges that snapshot
 * into its persisted, cross-window state after the request succeeds.
 */
function createProvidersQueryOptions() {
  return {
    key: PROVIDERS_QUERY_KEY,
    query: async (context: { signal: AbortSignal }) => {
      const remote = await service.fetchRemote(client, { abortSignal: context.signal })
      return remote
    },
    enabled: false,
  }
}

/**
 * Stores serializable provider instances and their configuration.
 *
 * Pinia Colada owns remote request state. This store remains the source of
 * truth for the local, cross-window provider snapshot.
 */
export const useProviderConfigStore = defineStore('provider-config', () => {
  const providers = useLocalStorage<Record<string, InferenceServiceProvider>>('settings/providers/configured', {}, providerStorageOptions)
  const addedProviders = useLocalStorage<Record<string, boolean>>('settings/providers/added', {}, providerStorageOptions)
  const legacyConfigs = useLocalStorage<Record<string, Record<string, unknown>>>('settings/credentials/providers', {}, providerStorageOptions)

  // Import the previous provider configuration shape once. Provider ids remain
  // stable, so existing model selections keep pointing at the same provider.
  for (const [providerId, config] of Object.entries(legacyConfigs.value)) {
    if (providers.value[providerId])
      continue

    const definitionId = providerId.startsWith('vision-')
      ? providerId.slice('vision-'.length)
      : providerId
    const definition = getDefinedProvider(definitionId)
    if (!definition)
      continue

    providers.value[providerId] = {
      id: providerId,
      definitionId,
      config,
      status: 'unconfigured',
      configuredBy: definition.configuredBy ?? 'user',
    }
  }

  // Provider definitions own configuration lifecycle policy. Apply that
  // policy to persisted snapshots before module pages consume them. Providers
  // without an owner declaration remain user-configured.
  for (const provider of Object.values(providers.value)) {
    const configuredByDefinition = getDefinedProvider(provider.definitionId)?.configuredBy
    if (configuredByDefinition) {
      provider.configuredBy = configuredByDefinition
    }
    else if (!provider.configuredBy) {
      provider.configuredBy = 'user'
    }
  }

  const providersQuery = useQuery(createProvidersQueryOptions())
  const addProviderMutation = useMutation({
    mutation: async (provider: InferenceServiceProvider) => service.createRemote(client, provider),
  })
  const removeProviderMutation = useMutation({
    mutation: async (providerId: string) => service.deleteRemote(client, providerId),
  })
  const updateProviderMutation = useMutation({
    mutation: async (payload: {
      providerId: string
      config: Record<string, unknown>
      status: ProviderValidationStatus
    }) => service.patchConfigRemote(client, payload.providerId, payload.config, payload.status),
  })

  const configs = computed(() => new Proxy({} as Record<string, Record<string, unknown>>, {
    get: (target, key, receiver) => {
      if (typeof key !== 'string')
        return Reflect.get(target, key, receiver)

      return providers.value[key]?.config
    },
    set: (target, key, value, receiver) => {
      if (typeof key !== 'string')
        return Reflect.set(target, key, value, receiver)

      const config = { ...(value as Record<string, unknown>) }
      const provider = providers.value[key]
      if (provider) {
        provider.config = config
        return true
      }

      // A page may write configuration for a provider it has not created yet.
      // Seed the same record shape `ensureProvider` uses rather than dropping
      // the write. Provider ids match definition ids apart from the vision
      // prefix, which the legacy import above resolves the same way.
      const definitionId = key.startsWith('vision-') ? key.slice('vision-'.length) : key
      providers.value[key] = {
        id: key,
        definitionId,
        config,
        status: 'unconfigured',
        configuredBy: getDefinedProvider(definitionId)?.configuredBy ?? 'user',
      }

      return true
    },
    deleteProperty: (target, key) => {
      if (typeof key !== 'string')
        return Reflect.deleteProperty(target, key)

      delete providers.value[key]
      return true
    },
    has: (target, key) => {
      if (typeof key !== 'string')
        return Reflect.has(target, key)

      return key in providers.value
    },
    // `Object.entries(configs)` and object spread read the key list and then
    // ask for a descriptor per key. Both traps must agree with `get`, or the
    // enumeration drops every entry.
    ownKeys: () => Reflect.ownKeys(providers.value),
    getOwnPropertyDescriptor: (target, key) => {
      if (typeof key !== 'string')
        return Reflect.getOwnPropertyDescriptor(target, key)

      const provider = providers.value[key]
      if (!provider)
        return undefined

      return { configurable: true, enumerable: true, value: provider.config, writable: true }
    },
  }))
  const listedProviders = computed(() => Object.fromEntries(
    Object.entries(providers.value).filter(([providerId]) => addedProviders.value[providerId]),
  ))
  const configuredProviders = computed(() => Object.fromEntries(
    Object.entries(providers.value).map(([providerId, provider]) => [providerId, provider.status === 'configured']),
  ))
  const mutationError = computed(() =>
    addProviderMutation.error.value
    ?? removeProviderMutation.error.value
    ?? updateProviderMutation.error.value)

  function getProvider(providerId: string) {
    return providers.value[providerId]
  }

  function getProviderConfig(providerId: string) {
    return providers.value[providerId]?.config
  }

  function ensureProvider(providerId: string, definitionId: string, config: Record<string, unknown> = {}) {
    const current = providers.value[providerId]
    if (current)
      return current

    const definition = getDefinedProvider(definitionId)
    if (!definition)
      throw new Error(`Provider definition with id "${definitionId}" not found.`)

    const provider = {
      id: providerId,
      definitionId,
      config,
      status: 'unconfigured' as const,
      configuredBy: definition.configuredBy ?? 'user',
    }
    providers.value[providerId] = provider
    return provider
  }

  function markProviderAdded(providerId: string) {
    addedProviders.value[providerId] = true
  }

  function unmarkProviderAdded(providerId: string) {
    delete addedProviders.value[providerId]
  }

  function setProviderStatus(providerId: string, status: ProviderValidationStatus) {
    const provider = providers.value[providerId]
    if (provider)
      provider.status = status
  }

  /**
   * Updates the selected model in the leader-owned provider snapshot.
   *
   * Follower renderers must await this action instead of mutating replicated
   * configuration directly, because `state: true` proposals contain the full
   * store and can overwrite newer leader state.
   */
  async function setProviderModel(providerId: string, model: string) {
    const provider = providers.value[providerId]
    if (!provider)
      return

    providers.value[providerId] = {
      ...provider,
      config: { ...provider.config, model },
    }
  }

  /**
   * Updates the selected voice in the leader-owned provider snapshot.
   *
   * Speech synthesis and the provider settings page read the voice from the
   * provider configuration, so an AIRI Card selection reaches both only
   * through here.
   */
  async function setProviderVoice(providerId: string, voice: string) {
    const provider = providers.value[providerId]
    if (!provider)
      return

    providers.value[providerId] = {
      ...provider,
      config: { ...provider.config, voice },
    }
  }

  /**
   * Seeds a discovered default without replacing a model selected by the user.
   */
  async function setProviderModelIfUnset(providerId: string, model: string) {
    const provider = providers.value[providerId]
    if (!provider)
      return

    const currentModel = provider.config.model
    if (typeof currentModel === 'string' && currentModel.length > 0)
      return

    providers.value[providerId] = {
      ...provider,
      config: { ...provider.config, model },
    }
  }

  function mergeProviderSnapshot(snapshot: Record<string, InferenceServiceProvider>) {
    providers.value = { ...providers.value, ...snapshot }
    for (const providerId of Object.keys(snapshot))
      markProviderAdded(providerId)
  }

  async function fetchProviders() {
    try {
      const state = await providersQuery.refetch(true)
      if (state.data) {
        // The server snapshot has the highest priority for ids that exist remotely.
        mergeProviderSnapshot(state.data)
      }
      return providers.value
    }
    catch {
      // The merged local snapshot is authoritative while the remote endpoint is unavailable.
      return providers.value
    }
  }

  async function addProvider(definitionId: string, initialConfig: Record<string, unknown> = {}) {
    const provider = service.buildLocal(definitionId, initialConfig)
    providers.value[provider.id] = provider
    markProviderAdded(provider.id)

    try {
      const remote = await addProviderMutation.mutateAsync(provider)
      delete providers.value[provider.id]
      unmarkProviderAdded(provider.id)
      providers.value[remote.id] = remote
      markProviderAdded(remote.id)
      return remote
    }
    catch {
      // A failed remote create does not discard the local provider.
      return provider
    }
  }

  async function removeProvider(providerId: string) {
    if (!providers.value[providerId])
      return

    delete providers.value[providerId]
    unmarkProviderAdded(providerId)

    try {
      await removeProviderMutation.mutateAsync(providerId)
    }
    catch {
      // A failed remote delete does not restore a provider that the user removed locally.
    }
  }

  async function updateProviderConfig(providerId: string, config: Record<string, unknown>, status: ProviderValidationStatus) {
    const provider = providers.value[providerId]
    if (!provider)
      return

    const localProvider = {
      ...provider,
      config: { ...config },
      status,
    }
    providers.value[providerId] = localProvider

    try {
      const remote = await updateProviderMutation.mutateAsync({ providerId, config, status })
      providers.value[remote.id] = remote
      return remote
    }
    catch {
      // A failed remote update keeps the local provider configuration.
      return localProvider
    }
  }

  async function resetProviders() {
    providers.value = {}
    addedProviders.value = {}
  }

  return {
    providers,
    configs,
    addedProviders,
    listedProviders,
    configuredProviders,
    isLoading: computed(() => providersQuery.isLoading.value),
    error: computed(() => providersQuery.error.value),
    mutationError,

    getProvider,
    getProviderConfig,
    ensureProvider,
    markProviderAdded,
    unmarkProviderAdded,
    setProviderStatus,
    setProviderModel,
    setProviderModelIfUnset,
    setProviderVoice,
    fetchProviders,
    addProvider,
    removeProvider,
    updateProviderConfig,
    resetProviders,
  }
}, {
  synced: {
    actions: [
      'fetchProviders',
      'ensureProvider',
      'markProviderAdded',
      'unmarkProviderAdded',
      'setProviderStatus',
      'setProviderModel',
      'setProviderModelIfUnset',
      'setProviderVoice',
      'addProvider',
      'removeProvider',
      'updateProviderConfig',
      'resetProviders',
    ],
    state: true,
  },
})
