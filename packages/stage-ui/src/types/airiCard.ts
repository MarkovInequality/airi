import type { Card } from '@proj-airi/ccc'

/** Live2D stage view owned by a card, mirroring the on-stage view controls. */
export interface Live2DStageView {
  /** Model position relative to the center of the screen, in percentages. */
  x?: number
  y?: number
  /** Model scale multiplier. `1` fits the model to the stage. */
  scale?: number
}

/**
 * VRM stage view owned by a card, mirroring the on-stage view controls.
 *
 * VRM models are not scaled directly; their apparent size comes from the camera.
 */
export interface VRMStageView {
  /** Model position from the scene origin, in meters. */
  x?: number
  y?: number
  z?: number
  /** Euclidean distance between the model center and the camera center, in meters. */
  cameraDistance?: number
  /** Camera field of view, in degrees. */
  cameraFOV?: number
}

/** Per-renderer stage view a card restores when it is activated. */
export interface CardStageView {
  live2d?: Live2DStageView
  vrm?: VRMStageView
}

/** Body model settings a card owns for one renderer. */
export interface StageModelSettings<View> {
  source?: 'file' | 'url'
  file?: string
  url?: string
  /** Scale and position the model loads in at. Absent cards keep the runtime view. */
  view?: View
}

/**
 * AIRI-specific runtime configuration embedded in a character card.
 *
 * The extension is persisted with the card. Editor surfaces must preserve
 * fields they do not own so independent runtime modules can evolve without
 * losing each other's configuration.
 */
export interface AiriExtension {
  modules: {
    consciousness: {
      provider: string
      model: string
    }

    vision: {
      provider: string
      model: string
    }

    speech: {
      provider: string
      model: string
      voice_id: string

      pitch?: number
      rate?: number
      ssml?: boolean
      language?: string
    }

    vrm?: StageModelSettings<VRMStageView>

    live2d?: StageModelSettings<Live2DStageView>

    /** ID from the display-models store. */
    displayModelId?: string
    activeBackgroundId?: string

    artistry?: {
      enabled?: boolean
      provider?: string
      model?: string
      promptPrefix?: string
      workflowId?: string
      widgetInstruction?: string
      spawnMode?: 'bg' | 'widget' | 'inline' | 'bg_widget'
      options?: Record<string, unknown>
      autonomousEnabled?: boolean
      autonomousThreshold?: number
      autonomousTarget?: 'user' | 'assistant'
    }
  }

  agents: Record<string, {
    prompt: string
    enabled?: boolean
  }>
}

/** Character card normalized with the AIRI extension required by the runtime. */
export interface AiriCard extends Card {
  extensions: {
    airi: AiriExtension
  } & Card['extensions']
}
