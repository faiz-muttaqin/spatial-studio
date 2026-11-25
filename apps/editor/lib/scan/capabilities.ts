import type {
  BrowserCapabilities,
  CapabilitySupport,
  ScanBundleMetadata,
  SensorPermission,
} from '@pascal-app/core/capture'

/** Optional AR features. They are requested when a session starts, so a probe cannot know them. */
export const WEBXR_OPTIONAL_FEATURES = [
  'hit-test',
  'depth-sensing',
  'camera-access',
  'plane-detection',
  'anchors',
  'dom-overlay',
] as const

type PermissionGatedEvent = { requestPermission?: unknown }

/** The globals the probe reads; tests pass a fake. */
export type ProbeScope = {
  isSecureContext?: boolean
  navigator?: {
    userAgent?: string
    mediaDevices?: {
      getUserMedia?: unknown
      enumerateDevices?: () => Promise<Array<{ kind: string }>>
    }
    xr?: { isSessionSupported?: (mode: string) => Promise<boolean> }
    permissions?: { query?: (descriptor: { name: string }) => Promise<{ state: string }> }
    userAgentData?: {
      platform?: string
      brands?: ReadonlyArray<{ brand: string; version: string }>
    }
  }
  DeviceOrientationEvent?: PermissionGatedEvent
  DeviceMotionEvent?: PermissionGatedEvent
}

/**
 * Reports what this browser offers for capture without prompting for anything:
 * no camera stream is opened and no XR session is requested.
 */
export async function probeBrowserCapabilities(
  scope: ProbeScope = globalThis as ProbeScope,
): Promise<BrowserCapabilities> {
  const navigator = scope.navigator ?? {}
  const mediaDevices = navigator.mediaDevices
  const immersiveAr = await probeImmersiveAr(navigator.xr)
  const featureSupport: CapabilitySupport =
    immersiveAr === 'unsupported' ? 'unsupported' : 'unknown'

  return {
    secureContext: scope.isSecureContext === true,
    browser: browserFamily(navigator),
    camera: {
      mediaDevices: typeof mediaDevices?.getUserMedia === 'function',
      videoInputs: await countVideoInputs(mediaDevices),
    },
    webxr: {
      api: navigator.xr !== undefined,
      immersiveAr,
      features: Object.fromEntries(WEBXR_OPTIONAL_FEATURES.map((name) => [name, featureSupport])),
    },
    orientation: {
      api: scope.DeviceOrientationEvent !== undefined,
      permission: await sensorPermission(scope.DeviceOrientationEvent, 'gyroscope', navigator),
    },
    motion: {
      api: scope.DeviceMotionEvent !== undefined,
      permission: await sensorPermission(scope.DeviceMotionEvent, 'accelerometer', navigator),
    },
  }
}

async function probeImmersiveAr(
  xr: { isSessionSupported?: (mode: string) => Promise<boolean> } | undefined,
): Promise<CapabilitySupport> {
  if (!xr?.isSessionSupported) return 'unsupported'
  try {
    return (await xr.isSessionSupported('immersive-ar')) ? 'supported' : 'unsupported'
  } catch {
    // Thrown for insecure contexts or a permissions policy that blocks XR.
    return 'unknown'
  }
}

async function countVideoInputs(
  mediaDevices: NonNullable<ProbeScope['navigator']>['mediaDevices'],
): Promise<number | null> {
  if (!mediaDevices?.enumerateDevices) return null
  try {
    // Called as a method: an unbound `enumerateDevices` throws "Illegal invocation".
    const devices = await mediaDevices.enumerateDevices()
    return devices.filter((device) => device.kind === 'videoinput').length
  } catch {
    return null
  }
}

/**
 * Chrome reports the sensor permissions through the Permissions API, so its
 * answer wins. iOS cannot be queried and gates orientation and motion behind
 * `requestPermission()`, which needs a tap: that reads as `prompt`. Otherwise
 * the events just fire.
 */
async function sensorPermission(
  event: PermissionGatedEvent | undefined,
  sensor: 'accelerometer' | 'gyroscope',
  navigator: NonNullable<ProbeScope['navigator']>,
): Promise<SensorPermission> {
  try {
    const status = await navigator.permissions?.query?.({ name: sensor })
    if (status?.state === 'granted' || status?.state === 'denied' || status?.state === 'prompt') {
      return status.state
    }
  } catch {
    // Not a queryable permission in this browser.
  }
  return typeof event?.requestPermission === 'function' ? 'prompt' : 'not-required'
}

const BRAND_NOISE = /not.?a.?brand|chromium/i

/**
 * Browser family and major version, e.g. `Chrome 140`. Manifests can be shared,
 * so the full user agent (device model, build) is never stored.
 */
export function browserFamily(navigator: NonNullable<ProbeScope['navigator']>): string | null {
  const brands = navigator.userAgentData?.brands ?? []
  const brand =
    brands.find((entry) => !BRAND_NOISE.test(entry.brand)) ??
    brands.find((entry) => /chromium/i.test(entry.brand))
  if (brand) return `${brand.brand} ${brand.version.split('.')[0]}`.slice(0, 64)

  const userAgent = navigator.userAgent ?? ''
  const patterns: Array<[string, RegExp]> = [
    ['Edge', /Edg(?:A|iOS)?\/(\d+)/],
    ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
  ]
  for (const [name, pattern] of patterns) {
    const match = pattern.exec(userAgent)
    if (match) return `${name} ${match[1]}`
  }
  return null
}

const OS_FAMILIES: Array<[string, RegExp]> = [
  ['Android', /Android/],
  ['iOS', /iPhone|iPad|iPod/],
  ['Windows', /Windows/],
  ['macOS', /Mac OS X|Macintosh/],
  ['Linux', /Linux/],
]

/**
 * Manifest `device` for a browser provider: the OS family only. Model and
 * manufacturer stay null, since shared scenes can expose the manifest.
 */
export function describeBrowserDevice(
  scope: ProbeScope = globalThis as ProbeScope,
): ScanBundleMetadata['device'] {
  const platform = scope.navigator?.userAgentData?.platform
  const userAgent = scope.navigator?.userAgent ?? ''
  const os = platform || OS_FAMILIES.find(([, pattern]) => pattern.test(userAgent))?.[0] || null
  return { manufacturer: null, model: null, os }
}
