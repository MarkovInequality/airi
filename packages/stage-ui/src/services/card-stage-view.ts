import type {
  AiriExtension,
  CardStageView,
  Live2DStageView,
  StageModelSettings,
  VRMStageView,
} from '../types/airiCard'

type CardModules = AiriExtension['modules']

/** Live2D view fields, in the order the on-stage controls expose them. */
export const live2dStageViewFields = ['x', 'y', 'scale'] as const
/** VRM view fields, in the order the on-stage controls expose them. */
export const vrmStageViewFields = ['x', 'y', 'z', 'cameraDistance', 'cameraFOV'] as const

/**
 * Reads the stage view a card owns.
 *
 * Cards are user-supplied JSON, and the renderers clamp with `Math.min`/`Math.max`,
 * which passes `NaN` through, so fields are narrowed to finite numbers here.
 *
 * `undefined` means the card owns no view; callers keep the current runtime
 * view rather than resetting the stage to renderer defaults.
 */
export function resolveCardStageView(modules: CardModules | undefined): CardStageView | undefined {
  const live2d = pickFiniteFields(modules?.live2d?.view, live2dStageViewFields)
  const vrm = pickFiniteFields(modules?.vrm?.view, vrmStageViewFields)
  if (!live2d && !vrm)
    return undefined

  return {
    ...(live2d ? { live2d } : {}),
    ...(vrm ? { vrm } : {}),
  }
}

/**
 * Builds the module patch that stores `view` on a card.
 *
 * Preserves the body model source no view surface owns, and drops a renderer
 * entry once nothing is left to persist.
 */
export function mergeCardStageViewIntoModules(
  modules: CardModules | undefined,
  view: CardStageView | undefined,
): Pick<CardModules, 'live2d' | 'vrm'> {
  return {
    live2d: withStageView(modules?.live2d, pickFiniteFields(view?.live2d, live2dStageViewFields)),
    vrm: withStageView(modules?.vrm, pickFiniteFields(view?.vrm, vrmStageViewFields)),
  }
}

function withStageView<View extends Live2DStageView | VRMStageView>(
  settings: StageModelSettings<View> | undefined,
  view: View | undefined,
): StageModelSettings<View> | undefined {
  const { view: _replaced, ...source } = settings ?? {}
  const next: StageModelSettings<View> = view ? { ...source, view } : { ...source }

  return Object.keys(next).length > 0 ? next : undefined
}

function pickFiniteFields<View extends Live2DStageView | VRMStageView>(
  view: View | undefined,
  fields: readonly (keyof View & string)[],
): View | undefined {
  if (!view)
    return undefined

  const picked = {} as View
  for (const field of fields) {
    const value = view[field]
    if (typeof value === 'number' && Number.isFinite(value))
      picked[field] = value
  }

  return Object.keys(picked).length > 0 ? picked : undefined
}
