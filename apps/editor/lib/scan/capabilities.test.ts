import { describe, expect, test } from 'bun:test'
import { BrowserCapabilitiesSchema } from '@pascal-app/core/capture'
import { describeBrowserDevice, probeBrowserCapabilities } from './capabilities'
import { fitLongEdge } from './photo'
import { captureName } from './session'

describe('probeBrowserCapabilities', () => {
  test('reports a Chrome-on-Android-like browser without prompting', async () => {
    const queried: string[] = []
    const mediaDevices = {
      getUserMedia: () => {},
      // Like the real API, it only works when called on its owner.
      async enumerateDevices(this: unknown) {
        if (this !== mediaDevices) throw new TypeError('Illegal invocation')
        return [{ kind: 'videoinput' }, { kind: 'videoinput' }, { kind: 'audioinput' }]
      },
    }
    const result = await probeBrowserCapabilities({
      isSecureContext: true,
      navigator: {
        userAgent: 'Mozilla/5.0 (Linux; Android 16)',
        mediaDevices,
        xr: { isSessionSupported: async (mode) => mode === 'immersive-ar' },
        permissions: {
          query: async ({ name }) => {
            queried.push(name)
            return { state: name === 'accelerometer' ? 'granted' : 'denied' }
          },
        },
      },
      // Recent Chrome also exposes requestPermission; the queried state still wins.
      DeviceOrientationEvent: { requestPermission: () => {} },
      DeviceMotionEvent: {},
    })

    expect(BrowserCapabilitiesSchema.parse(result)).toEqual(result)
    expect(result.camera).toEqual({ mediaDevices: true, videoInputs: 2 })
    expect(result.webxr.immersiveAr).toBe('supported')
    // Optional features are negotiated at session start, so they stay unknown.
    expect(new Set(Object.values(result.webxr.features))).toEqual(new Set(['unknown']))
    expect(result.motion.permission).toBe('granted')
    expect(result.orientation.permission).toBe('denied')
    expect(queried.sort()).toEqual(['accelerometer', 'gyroscope'])
  })

  test('reports an iOS-like browser: no WebXR, sensors behind requestPermission', async () => {
    const result = await probeBrowserCapabilities({
      isSecureContext: true,
      navigator: { userAgent: 'iPhone', mediaDevices: { getUserMedia: () => {} } },
      DeviceOrientationEvent: { requestPermission: () => {} },
      DeviceMotionEvent: { requestPermission: () => {} },
    })
    expect(result.webxr).toMatchObject({ api: false, immersiveAr: 'unsupported' })
    expect(result.webxr.features['depth-sensing']).toBe('unsupported')
    expect(result.orientation.permission).toBe('prompt')
    expect(result.camera.videoInputs).toBeNull()
  })

  test('reports unknown when the XR check throws and nothing on an insecure page', async () => {
    const result = await probeBrowserCapabilities({
      isSecureContext: false,
      navigator: {
        xr: {
          isSessionSupported: async () => {
            throw new Error('SecurityError')
          },
        },
      },
    })
    expect(result.secureContext).toBe(false)
    expect(result.camera.mediaDevices).toBe(false)
    expect(result.webxr.immersiveAr).toBe('unknown')
    expect(result.motion).toEqual({ api: false, permission: 'not-required' })
  })
})

describe('describeBrowserDevice', () => {
  test('uses client hints when offered and never claims a manufacturer', async () => {
    expect(
      await describeBrowserDevice({
        navigator: {
          userAgentData: {
            platform: 'Android',
            getHighEntropyValues: async () => ({ model: 'Pixel Test', platformVersion: '16.0.0' }),
          },
        },
      }),
    ).toEqual({ manufacturer: null, model: 'Pixel Test', os: 'Android 16.0.0' })
    expect(await describeBrowserDevice({ navigator: {} })).toEqual({
      manufacturer: null,
      model: null,
      os: null,
    })
  })
})

describe('photo and session helpers', () => {
  test('fits the long edge to 1920 px and keeps smaller photos', () => {
    expect(fitLongEdge(4032, 3024)).toEqual({ width: 1920, height: 1440 })
    expect(fitLongEdge(3000, 4000)).toEqual({ width: 1440, height: 1920 })
    expect(fitLongEdge(1280, 960)).toEqual({ width: 1280, height: 960 })
  })

  test('names captures by local date and time', () => {
    expect(captureName(new Date(2026, 10, 5, 9, 7))).toBe('Room scan 2026-11-05 09:07')
  })
})
