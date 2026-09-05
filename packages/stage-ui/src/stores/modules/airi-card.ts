import type { Card, ccv3 } from '@proj-airi/ccc'

import type { AiriCard, AiriExtension, CardStageView } from '../../types/airiCard'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { until } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT } from '../../constants/prompts/character-defaults'
import { captureAnalyticsEvent } from '../../libs/product-signals'
import { live2dStageViewFields, mergeCardStageViewIntoModules, resolveCardStageView, vrmStageViewFields } from '../../services/card-stage-view'
import { useProviderConfigStore } from '../providers/config'
import { useSettingsStageModel } from '../settings/stage-model'
import { useArtistryStore } from './artistry'
import { useConsciousnessStore } from './consciousness'
import { useSpeechStore } from './speech'
import { useVisionStore } from './vision'

export type { AiriCard, AiriExtension, CardStageView } from '../../types/airiCard'

function resolveSystemPrompt(card: AiriCard | undefined): string {
  if (!card)
    return ''

  // Position-sensitive CCv3 fields are deliberately excluded until provider
  // message assembly owns their ordering and role semantics.
  const systemPromptParts = [
    card.systemPrompt,
    card.description,
    card.personality,
    card.scenario,
    card.extensions.airi.modules.artistry?.widgetInstruction,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)

  return systemPromptParts.join('\n\n')
}

type StageModelStore = ReturnType<typeof useSettingsStageModel>

/** Gives up waiting for the stage so a model that never loads cannot leave an application pending. */
const stageViewSettleTimeout = 30_000

/** Only the newest application may write to the view controls, since each one waits on the stage. */
let stageViewApplySequence = 0

/**
 * Reads the stage view of the renderer currently on stage.
 *
 * Live2D and VRM own separate view control systems and the other renderers
 * own none, so at most one view is worth saving on a card. The controls are
 * browser-only modules, loaded lazily here as the stage model store does.
 */
async function captureRuntimeStageView(stageModel: StageModelStore): Promise<CardStageView | undefined> {
  if (typeof window === 'undefined')
    return undefined

  if (stageModel.stageModelRenderer === 'live2d') {
    const { useL2dViewControl } = await import('../live2d')
    const { position, scale } = useL2dViewControl()

    return {
      live2d: {
        x: position.value.x,
        y: position.value.y,
        scale: scale.value,
      },
    }
  }

  if (stageModel.stageModelRenderer === 'vrm') {
    const { useThreeViewControl } = await import('@proj-airi/stage-ui-three')
    const { modelOffset, cameraDistance, cameraFOV } = useThreeViewControl()

    return {
      vrm: {
        x: modelOffset.value.x,
        y: modelOffset.value.y,
        z: modelOffset.value.z,
        cameraDistance: cameraDistance.value,
        cameraFOV: cameraFOV.value,
      },
    }
  }

  return undefined
}

/**
 * Restores a card's stage view once the stage is ready to keep it.
 *
 * Fields are replayed through the renderer's own `set` command, which clamps
 * them to the range its sliders allow. Omitted fields keep the current runtime
 * value, so cards saved before stage views existed leave the stage alone.
 */
async function applyRuntimeStageView(
  view: CardStageView | undefined,
  stageModel: StageModelStore,
  displayModelId: string | undefined,
) {
  if (!view || typeof window === 'undefined')
    return

  const sequence = ++stageViewApplySequence

  // The renderer showing this body model owns the card's framing.
  // `stageModelSelectedDisplayModel` publishes last, so waiting on it settles
  // the renderer too.
  if (displayModelId && stageModel.stageModelSelectedDisplayModel?.id !== displayModelId) {
    await until(() => stageModel.stageModelSelectedDisplayModel?.id).toBe(displayModelId, { timeout: stageViewSettleTimeout })
    if (sequence !== stageViewApplySequence)
      return
  }

  if (stageModel.stageModelRenderer === 'live2d' && view.live2d) {
    const { useL2dViewControl } = await import('../live2d')
    if (sequence !== stageViewApplySequence)
      return

    const { set } = useL2dViewControl()
    for (const field of live2dStageViewFields) {
      const value = view.live2d[field]
      if (value != null)
        set(field, value)
    }

    return
  }

  if (stageModel.stageModelRenderer === 'vrm' && view.vrm) {
    const { useModelStore, useThreeViewControl } = await import('@proj-airi/stage-ui-three')
    if (sequence !== stageViewApplySequence)
      return

    // NOTICE:
    // A view restored before the VRM scene finishes loading is overwritten:
    // `applySceneBootstrap` refits the offset and camera on `initial-load` and
    // `model-switch` (packages/stage-ui-three/src/components/ThreeScene.vue).
    // Removable once the scene keeps a restored view across a load.
    const modelStore = useModelStore()
    if (displayModelId && modelStore.lastCommittedModelId !== displayModelId) {
      await until(() => modelStore.lastCommittedModelId).toBe(displayModelId, { timeout: stageViewSettleTimeout })
      if (sequence !== stageViewApplySequence)
        return
    }

    const { set } = useThreeViewControl()
    for (const field of vrmStageViewFields) {
      const value = view.vrm[field]
      if (value != null)
        set(field, value)
    }
  }
}

export const useAiriCardStore = defineStore('airi-card', () => {
  const { t } = useI18n()

  // Pinia synchronization owns cross-window updates. Local storage only loads
  // and saves this renderer's durable copy; listening to storage events here
  // would create a second cross-window state channel and echo cloned maps.
  const cards = useLocalStorageManualReset<Map<string, AiriCard>>('airi-cards', new Map(), { listenToStorageChanges: false })
  const activeCardId = useLocalStorageManualReset<string>('airi-card-active-id', 'default', { listenToStorageChanges: false })
  let initialized = false

  const activeCard = computed(() => cards.value.get(activeCardId.value))
  function useRuntimeModuleStores() {
    return {
      artistry: useArtistryStore(),
      consciousness: useConsciousnessStore(),
      providerConfig: useProviderConfigStore(),
      speech: useSpeechStore(),
      stageModel: useSettingsStageModel(),
      vision: useVisionStore(),
    }
  }

  /**
   * `source` feeds the `card_created` analytics event: `scratch` = built in
   * the creation dialog, `import` = ccv3 JSON upload, `duplicate` = cloned
   * from an existing card (profile switcher). Required so a new call site
   * can't silently degrade creation attribution.
   */
  const addCard = async (card: AiriCard | Card | ccv3.CharacterCardV3, source: 'scratch' | 'import' | 'duplicate') => {
    const newCardId = nanoid()
    cards.value.set(newCardId, newAiriCard(card))
    captureAnalyticsEvent('card_created', { card_id: newCardId, source })
    return newCardId
  }

  const removeCard = async (id: string) => {
    // The built-in card is the guaranteed fallback for every runtime profile.
    if (id === 'default')
      return false

    const removed = cards.value.delete(id)
    if (!removed)
      return false

    // The active id is persisted independently from the card map. Reset it
    // before consumers observe a dangling runtime profile after deletion.
    if (activeCardId.value === id) {
      activeCardId.value = 'default'
      await applyActiveCardSettings()
    }

    captureAnalyticsEvent('character_deleted', { character_id: id })
    return true
  }

  const updateCard = async (id: string, updates: AiriCard | Card | ccv3.CharacterCardV3) => {
    const existingCard = cards.value.get(id)
    if (!existingCard)
      return false

    const updatedCard = {
      ...existingCard,
      ...updates,
    }

    const card = newAiriCard(updatedCard)
    cards.value.set(id, card)
    if (id === activeCardId.value)
      await applyActiveCardSettings(card)

    return true
  }

  const getCard = (id: string) => {
    return cards.value.get(id)
  }

  function updateActiveCardModules(patch: (extension: AiriExtension) => Partial<AiriExtension['modules']>) {
    const cardId = activeCardId.value
    const card = cards.value.get(cardId)
    if (!card)
      return false

    const extension = resolveAiriExtension(card)
    cards.value.set(cardId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...extension,
          modules: {
            ...extension.modules,
            ...patch(extension),
          },
        },
      },
    })

    return true
  }

  async function updateActiveCardDisplayModel(displayModelId: string | undefined) {
    const updated = updateActiveCardModules(() => ({ displayModelId }))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  /**
   * Stores the scale and position the active card's body model loads in at.
   *
   * Pass `undefined` to drop the view so the card stops moving the stage on
   * activation. `captureStageView` produces the value to save.
   */
  async function updateActiveCardStageView(view: CardStageView | undefined) {
    const updated = updateActiveCardModules(({ modules }) => mergeCardStageViewIntoModules(modules, view))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  /**
   * Snapshots the live stage view for a caller that is about to save a card.
   *
   * Resolves only the stage model store: creating the inference module stores
   * would make an editor surface load provider catalogs it never reads.
   */
  async function captureStageView() {
    return captureRuntimeStageView(useSettingsStageModel())
  }

  async function updateActiveCardConsciousness(consciousness: AiriExtension['modules']['consciousness']) {
    const updated = updateActiveCardModules(() => ({ consciousness }))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  async function updateActiveCardVision(vision: AiriExtension['modules']['vision']) {
    const updated = updateActiveCardModules(() => ({ vision }))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  async function updateActiveCardSpeech(speech: Pick<AiriExtension['modules']['speech'], 'provider' | 'model' | 'voice_id' | 'pitch' | 'ssml'>) {
    const updated = updateActiveCardModules(({ modules }) => ({
      speech: {
        ...modules.speech,
        ...speech,
      },
    }))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  /**
   * Persists the current inference selections in the active card.
   *
   * This command snapshots runtime state after a higher-level operation, such
   * as authenticated default setup. It deliberately does not apply the card
   * back to the runtime, so one persistence write cannot start another module
   * transition.
   */
  async function persistActiveCardModuleSelections() {
    const card = cards.value.get(activeCardId.value)
    if (!card)
      return false

    const {
      consciousness,
      speech,
      vision,
    } = useRuntimeModuleStores()
    const modules = card.extensions?.airi?.modules
    const alreadyPersisted = modules?.consciousness?.provider === consciousness.activeProvider
      && modules.consciousness.model === consciousness.activeModel
      && modules?.speech?.provider === speech.activeSpeechProvider
      && modules.speech.model === speech.activeSpeechModel
      && modules.speech.voice_id === speech.activeSpeechVoiceId
      && modules.speech.pitch === speech.pitch
      && modules.speech.ssml === speech.ssmlEnabled
      && modules?.vision?.provider === vision.activeProvider
      && modules.vision.model === vision.activeModel

    if (alreadyPersisted)
      return false

    return updateActiveCardModules(({ modules }) => ({
      consciousness: {
        provider: consciousness.activeProvider,
        model: consciousness.activeModel,
      },
      speech: {
        ...modules.speech,
        provider: speech.activeSpeechProvider,
        model: speech.activeSpeechModel,
        voice_id: speech.activeSpeechVoiceId,
        pitch: speech.pitch,
        ssml: speech.ssmlEnabled,
      },
      vision: {
        provider: vision.activeProvider,
        model: vision.activeModel,
      },
    }))
  }

  function resolveAiriExtension(card: Card | ccv3.CharacterCardV3): AiriExtension {
    const {
      artistry,
      consciousness,
      speech,
      stageModel,
      vision,
    } = useRuntimeModuleStores()

    // Get existing extension if available
    const existingExtension = ('data' in card
      ? card.data?.extensions?.airi
      : card.extensions?.airi) as AiriExtension

    // Create default modules config
    const defaultModules = {
      consciousness: {
        provider: consciousness.activeProvider,
        model: consciousness.activeModel,
      },
      vision: {
        provider: vision.activeProvider,
        model: vision.activeModel,
      },
      speech: {
        provider: speech.activeSpeechProvider,
        model: speech.activeSpeechModel,
        voice_id: speech.activeSpeechVoiceId,
        pitch: speech.pitch,
        ssml: speech.ssmlEnabled,
      },
      displayModelId: stageModel.stageModelSelected,
      artistry: {
        enabled: false,
        provider: artistry.globalProvider,
        model: artistry.globalModel,
        promptPrefix: artistry.globalPromptPrefix,
        widgetInstruction: DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT,
        spawnMode: 'bg_widget' as const,
        options: artistry.globalProviderOptions,
        autonomousEnabled: false,
        autonomousThreshold: 70,
        autonomousTarget: 'assistant' as const,
      },
    } as const

    // Return default if no extension exists
    if (!existingExtension) {
      return {
        modules: defaultModules,
        agents: {},
      }
    }

    // Merge existing extension with defaults
    return {
      modules: {
        consciousness: {
          provider: existingExtension.modules?.consciousness?.provider ?? defaultModules.consciousness.provider,
          model: existingExtension.modules?.consciousness?.model ?? defaultModules.consciousness.model,
        },
        vision: {
          provider: existingExtension.modules?.vision?.provider ?? defaultModules.vision.provider,
          model: existingExtension.modules?.vision?.model ?? defaultModules.vision.model,
        },
        speech: {
          provider: existingExtension.modules?.speech?.provider ?? defaultModules.speech.provider,
          model: existingExtension.modules?.speech?.model ?? defaultModules.speech.model,
          voice_id: existingExtension.modules?.speech?.voice_id ?? defaultModules.speech.voice_id,
          pitch: existingExtension.modules?.speech?.pitch ?? defaultModules.speech.pitch,
          rate: existingExtension.modules?.speech?.rate,
          ssml: existingExtension.modules?.speech?.ssml ?? defaultModules.speech.ssml,
          language: existingExtension.modules?.speech?.language,
        },
        vrm: existingExtension.modules?.vrm,
        live2d: existingExtension.modules?.live2d,
        displayModelId: existingExtension.modules?.displayModelId ?? defaultModules.displayModelId,
        activeBackgroundId: existingExtension.modules?.activeBackgroundId,
        artistry: {
          enabled: existingExtension.modules?.artistry?.enabled ?? (existingExtension as any).artistry?.enabled ?? defaultModules.artistry.enabled,
          provider: existingExtension.modules?.artistry?.provider ?? (existingExtension as any).artistry?.provider ?? defaultModules.artistry.provider,
          model: existingExtension.modules?.artistry?.model ?? (existingExtension as any).artistry?.model ?? defaultModules.artistry.model,
          promptPrefix: existingExtension.modules?.artistry?.promptPrefix ?? (existingExtension as any).artistry?.promptPrefix ?? (existingExtension as any).artistry?.prompt_prefix ?? defaultModules.artistry.promptPrefix,
          workflowId: existingExtension.modules?.artistry?.workflowId ?? (existingExtension as any).artistry?.workflowId ?? (existingExtension as any).artistry?.remixId,
          widgetInstruction: existingExtension.modules?.artistry?.widgetInstruction ?? (existingExtension as any).artistry?.widgetInstruction ?? defaultModules.artistry.widgetInstruction,
          spawnMode: existingExtension.modules?.artistry?.spawnMode ?? (existingExtension as any).artistry?.spawnMode ?? defaultModules.artistry.spawnMode,
          options: existingExtension.modules?.artistry?.options ?? (existingExtension as any).artistry?.options ?? defaultModules.artistry.options,
          autonomousEnabled: existingExtension.modules?.artistry?.autonomousEnabled ?? (existingExtension as any).artistry?.autonomousEnabled ?? defaultModules.artistry.autonomousEnabled,
          autonomousThreshold: existingExtension.modules?.artistry?.autonomousThreshold ?? (existingExtension as any).artistry?.autonomousThreshold ?? defaultModules.artistry.autonomousThreshold,
          autonomousTarget: existingExtension.modules?.artistry?.autonomousTarget ?? (existingExtension as any).artistry?.autonomousTarget ?? defaultModules.artistry.autonomousTarget,
        },
      },
      agents: existingExtension.agents ?? {},
    }
  }

  function newAiriCard(card: Card | ccv3.CharacterCardV3): AiriCard {
    // Handle ccv3 format if needed
    if ('data' in card) {
      const ccv3Card = card as ccv3.CharacterCardV3
      return {
        name: ccv3Card.data.name,
        version: ccv3Card.data.character_version ?? '1.0.0',
        description: ccv3Card.data.description ?? '',
        creator: ccv3Card.data.creator ?? '',
        notes: ccv3Card.data.creator_notes ?? '',
        notesMultilingual: ccv3Card.data.creator_notes_multilingual,
        personality: ccv3Card.data.personality ?? '',
        scenario: ccv3Card.data.scenario ?? '',
        greetings: [
          ccv3Card.data.first_mes,
          ...(ccv3Card.data.alternate_greetings ?? []),
        ],
        greetingsGroupOnly: ccv3Card.data.group_only_greetings ?? [],
        systemPrompt: ccv3Card.data.system_prompt ?? '',
        postHistoryInstructions: ccv3Card.data.post_history_instructions ?? '',
        messageExample: ccv3Card.data.mes_example
          ? ccv3Card.data.mes_example
              .split('<START>\n')
              .filter(Boolean)
              .map(example => example.split('\n')
                .map((line) => {
                  if (line.startsWith('{{char}}:') || line.startsWith('{{user}}:'))
                    return line as `{{char}}: ${string}` | `{{user}}: ${string}`
                  throw new Error(`Invalid message example format: ${line}`)
                }))
          : [],
        tags: ccv3Card.data.tags ?? [],
        extensions: {
          airi: resolveAiriExtension(ccv3Card),
          ...ccv3Card.data.extensions,
        },
      }
    }

    return {
      ...card,
      extensions: {
        airi: resolveAiriExtension(card),
        ...card.extensions,
      },
    }
  }

  async function initialize() {
    // This synchronized action executes in the leader. Each window calls it,
    // but only the first call can apply persisted card settings to the runtime.
    if (initialized)
      return

    initialized = true
    if (!cards.value.has('default')) {
      cards.value.set('default', newAiriCard({
        name: 'ReLU',
        version: '1.0.0',
        description: t('base.prompt.prefix'),
      }))
    }
    // The active id and card map are persisted separately. Older versions
    // could delete the selected card without repairing its stored id.
    if (!cards.value.has(activeCardId.value))
      activeCardId.value = 'default'

    await applyActiveCardSettings()
  }

  /**
   * Selects a card and applies its module settings in the synchronization
   * leader. Replicated state snapshots never invoke this command.
   */
  async function activateCard(id: string) {
    if (!cards.value.has(id))
      return false

    activeCardId.value = id
    await applyActiveCardSettings()
    return true
  }

  async function applyActiveCardSettings(newCard = activeCard.value) {
    const {
      artistry,
      consciousness,
      providerConfig,
      speech,
      stageModel,
      vision,
    } = useRuntimeModuleStores()

    artistry.resetToGlobal()

    if (!newCard)
      return

    // TODO: Minecraft Agent, etc
    const extension = resolveAiriExtension(newCard)
    if (!extension)
      return

    const consciousnessSettings = extension.modules?.consciousness
    if (consciousnessSettings?.provider)
      consciousness.activeProvider = consciousnessSettings.provider
    if (consciousnessSettings?.model)
      consciousness.activeModel = consciousnessSettings.model

    const visionSettings = extension.modules?.vision
    if (visionSettings?.provider)
      vision.activeProvider = visionSettings.provider
    if (visionSettings?.model)
      vision.activeModel = visionSettings.model

    const speechSettings = extension.modules?.speech
    if (speechSettings?.provider)
      speech.activeSpeechProvider = speechSettings.provider
    if (speechSettings?.model)
      speech.activeSpeechModel = speechSettings.model
    if (speechSettings?.voice_id)
      speech.activeSpeechVoiceId = speechSettings.voice_id
    // 0 and false are real selections, so these apply on presence.
    if (speechSettings?.pitch != null)
      speech.pitch = speechSettings.pitch
    if (speechSettings?.ssml != null)
      speech.ssmlEnabled = speechSettings.ssml

    // Apply body model if the card has a display model configured.
    // NOTICE: must set via store property directly (not storeToRefs .value) so Pinia's
    // proxy correctly calls the writable computed setter → stageModelSelectedState → updateStageModel().
    if (extension.modules?.displayModelId) {
      stageModel.stageModelSelected = extension.modules.displayModelId
    }

    // The view can only be restored once the body model resolves, so this
    // settles after the rest of the card. Renderers watch their view state and
    // reposition the model whenever it lands.
    void applyRuntimeStageView(resolveCardStageView(extension.modules), stageModel, extension.modules?.displayModelId)

    if (extension.modules?.artistry) {
      if (extension.modules.artistry.provider)
        artistry.activeProvider = extension.modules.artistry.provider
      if (extension.modules.artistry.model)
        artistry.activeModel = extension.modules.artistry.model
      if (extension.modules.artistry.promptPrefix)
        artistry.defaultPromptPrefix = extension.modules.artistry.promptPrefix
      if (extension.modules.artistry.options)
        artistry.providerOptions = extension.modules.artistry.options
    }

    // Speech synthesis reads the model and voice from the provider's own
    // configuration for OpenAI-compatible endpoints, and the provider settings
    // page renders that configuration for every provider. A card selection
    // that stops at the speech module reaches neither. This runs last so the
    // module assignments above stay in one synchronous pass.
    const speechProviderId = speechSettings?.provider || speech.activeSpeechProvider
    if (speechProviderId && speechSettings?.model)
      await providerConfig.setProviderModel(speechProviderId, speechSettings.model)
    if (speechProviderId && speechSettings?.voice_id)
      await providerConfig.setProviderVoice(speechProviderId, speechSettings.voice_id)
  }

  function resetState() {
    initialized = false
    cards.reset()
    activeCardId.reset()
  }

  return {
    cards,
    activeCard,
    activeCardId,
    addCard,
    removeCard,
    updateCard,
    captureStageView,
    updateActiveCardConsciousness,
    updateActiveCardDisplayModel,
    updateActiveCardStageView,
    persistActiveCardModuleSelections,
    updateActiveCardSpeech,
    updateActiveCardVision,
    getCard,
    resetState,
    initialize,
    activateCard,

    currentModels: computed(() => {
      const {
        consciousness,
        speech,
        stageModel,
        vision,
      } = useRuntimeModuleStores()

      return {
        consciousness: {
          provider: consciousness.activeProvider,
          model: consciousness.activeModel,
        },
        vision: {
          provider: vision.activeProvider,
          model: vision.activeModel,
        },
        speech: {
          provider: speech.activeSpeechProvider,
          model: speech.activeSpeechModel,
          voice_id: speech.activeSpeechVoiceId,
          pitch: speech.pitch,
          ssml: speech.ssmlEnabled,
        },
        displayModelId: stageModel.stageModelSelected,
        activeBackgroundId: activeCard.value?.extensions?.airi?.modules?.activeBackgroundId,
      } satisfies AiriExtension['modules']
    }),
    systemPrompt: computed(() => resolveSystemPrompt(activeCard.value)),
  }
}, {
  synced: {
    actions: [
      'activateCard',
      'addCard',
      'initialize',
      'removeCard',
      'persistActiveCardModuleSelections',
      'updateActiveCardConsciousness',
      'updateActiveCardDisplayModel',
      'updateActiveCardSpeech',
      'updateActiveCardStageView',
      'updateActiveCardVision',
      'updateCard',
    ],
    state: true,
  },
})
