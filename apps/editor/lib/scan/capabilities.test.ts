import { describe, expect, test } from 'bun:test'
import { BrowserCapabilitiesSchema } from '@pascal-app/core/capture'
import { browserFamily, describeBrowserDevice, probeBrowserCapabilities } from './capabilities'
import { captureTimestamp, fitLongEdge } from './photo'
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

describe('describeBrowserDevice and browserFamily', () => {
  const pixelUa =
    'Mozilla/5.0 (Linux; Android 16; Pixel Test) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7000.10 Mobile Safari/537.36'
  const iphoneUa =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'

  test('keeps the OS family only, never a model', () => {
    expect(
      describeBrowserDevice({
        navigator: { userAgent: pixelUa, userAgentData: { platform: 'Android' } },
      }),
    ).toEqual({ manufacturer: null, model: null, os: 'Android' })
    expect(describeBrowserDevice({ navigator: { userAgent: iphoneUa } })).toEqual({
      manufacturer: null,
      model: null,
      os: 'iOS',
    })
    expect(describeBrowserDevice({ navigator: {} }).os).toBeNull()
  })

  test('reports browser family and major version, without the device model', () => {
    const chrome = browserFamily({
      userAgent: pixelUa,
      userAgentData: {
        brands: [
          { brand: 'Not A(Brand', version: '99' },
          { brand: 'Chromium', version: '140' },
          { brand: 'Google Chrome', version: '140' },
        ],
      },
    })
    expect(chrome).toBe('Google Chrome 140')
    expect(browserFamily({ userAgent: pixelUa })).toBe('Chrome 140')
    expect(browserFamily({ userAgent: iphoneUa })).toBe('Safari 19')
    expect(
      browserFamily({
        userAgent: 'Mozilla/5.0 (Android 16; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0',
      }),
    ).toBe('Firefox 150')
    expect(browserFamily({ userAgent: 'curl/8' })).toBeNull()
  })
})

describe('photo and session helpers', () => {
  test('fits the long edge to 1920 px and keeps smaller photos', () => {
    expect(fitLongEdge(4032, 3024)).toEqual({ width: 1920, height: 1440 })
    expect(fitLongEdge(3000, 4000)).toEqual({ width: 1440, height: 1920 })
    expect(fitLongEdge(1280, 960)).toEqual({ width: 1280, height: 960 })
  })

  test('uses a file time only when it is from the last day', () => {
    const now = Date.UTC(2026, 10, 25, 12)
    const hour = 60 * 60 * 1000
    expect(captureTimestamp(now - hour, now)).toBe(now - hour)
    expect(captureTimestamp(now - 400 * 24 * hour, now)).toBe(now)
    expect(captureTimestamp(now + 2 * hour, now)).toBe(now)
    expect(captureTimestamp(Number.NaN, now)).toBe(now)
  })

  test('names captures by local date and time', () => {
    expect(captureName(new Date(2026, 10, 5, 9, 7))).toBe('Room scan 2026-11-05 09:07')
  })
})
