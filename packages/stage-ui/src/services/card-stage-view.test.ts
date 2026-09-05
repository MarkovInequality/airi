import { describe, expect, it } from 'vitest'

import { mergeCardStageViewIntoModules, resolveCardStageView } from './card-stage-view'

const baseModules = {
  consciousness: { provider: 'p', model: 'm' },
  vision: { provider: 'p', model: 'm' },
  speech: { provider: 'p', model: 'm', voice_id: 'v' },
}

describe('resolveCardStageView', () => {
  it('reads the view each renderer owns', () => {
    expect(resolveCardStageView({
      ...baseModules,
      live2d: { view: { x: 12, y: -4, scale: 1.4 } },
      vrm: { view: { x: 0, y: 1.2, z: -0.5, cameraDistance: 2, cameraFOV: 30 } },
    })).toEqual({
      live2d: { x: 12, y: -4, scale: 1.4 },
      vrm: { x: 0, y: 1.2, z: -0.5, cameraDistance: 2, cameraFOV: 30 },
    })
  })

  it('reports no view for cards saved before stage views existed', () => {
    expect(resolveCardStageView(baseModules)).toBeUndefined()
    expect(resolveCardStageView({ ...baseModules, live2d: { source: 'url', url: 'https://example.com/model.zip' } })).toBeUndefined()
  })

  // A NaN field survives the renderer clamp and corrupts the scene transform,
  // with no way to recover from the sliders.
  it('drops fields that are not finite numbers', () => {
    expect(resolveCardStageView({
      ...baseModules,
      live2d: { view: { x: Number.NaN, y: 3, scale: Number.POSITIVE_INFINITY } },
      vrm: { view: { x: 'far' as unknown as number, cameraFOV: 40 } },
    })).toEqual({
      live2d: { y: 3 },
      vrm: { cameraFOV: 40 },
    })
  })
})

describe('mergeCardStageViewIntoModules', () => {
  it('keeps the body model source the view surfaces do not own', () => {
    expect(mergeCardStageViewIntoModules(
      { ...baseModules, live2d: { source: 'url', url: 'https://example.com/model.zip' } },
      { live2d: { x: 5, y: 0, scale: 1 } },
    )).toEqual({
      live2d: { source: 'url', url: 'https://example.com/model.zip', view: { x: 5, y: 0, scale: 1 } },
      vrm: undefined,
    })
  })

  it('drops the stored view without dropping the renderer entry', () => {
    expect(mergeCardStageViewIntoModules(
      {
        ...baseModules,
        live2d: { source: 'file', file: 'model.zip', view: { x: 5 } },
        vrm: { view: { cameraDistance: 3 } },
      },
      undefined,
    )).toEqual({
      live2d: { source: 'file', file: 'model.zip' },
      vrm: undefined,
    })
  })
})
