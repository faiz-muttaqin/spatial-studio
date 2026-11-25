'use client'

import type {
  BrowserCapabilities,
  CapabilitySupport,
  NativeCapabilities,
  SensorPermission,
} from '@pascal-app/core/capture'
import { usePascalI18n } from '@pascal-app/core/i18n'
import type { BridgeHello } from '@/lib/scan/native-bridge'
import { cn } from '@/lib/utils'

export type NativeProbe =
  | { state: 'absent' }
  | { state: 'probing' }
  | { state: 'ready'; hello: BridgeHello; capabilities: NativeCapabilities | null }
  | { state: 'failed'; code: string; message: string }

type Tone = 'good' | 'bad' | 'neutral'

function Row({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd
        className={cn(
          'text-right font-medium text-sm',
          tone === 'good' && 'text-emerald-400',
          tone === 'bad' && 'text-red-400',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

export function CapabilityPanel({
  browser,
  native,
}: {
  browser: BrowserCapabilities | null
  native: NativeProbe
}) {
  const i18n = usePascalI18n()

  const support = (value: CapabilitySupport): [string, Tone] => {
    if (value === 'supported') {
      return [i18n._({ id: 'app.scan.probe.supported', message: 'Supported' }), 'good']
    }
    if (value === 'unsupported') {
      return [i18n._({ id: 'app.scan.probe.unsupported', message: 'Not supported' }), 'bad']
    }
    return [
      i18n._({ id: 'app.scan.probe.unknown', message: 'Unknown until a session starts' }),
      'neutral',
    ]
  }

  const permission = (api: boolean, value: SensorPermission): [string, Tone] => {
    if (!api) return [i18n._({ id: 'app.scan.probe.unavailable', message: 'Not available' }), 'bad']
    if (value === 'granted') {
      return [i18n._({ id: 'app.scan.probe.granted', message: 'Allowed' }), 'good']
    }
    if (value === 'denied') {
      return [i18n._({ id: 'app.scan.probe.denied', message: 'Blocked' }), 'bad']
    }
    if (value === 'prompt') {
      return [i18n._({ id: 'app.scan.probe.prompt', message: 'Asks when used' }), 'neutral']
    }
    return [i18n._({ id: 'app.scan.probe.available', message: 'Available' }), 'good']
  }

  if (!browser) {
    return (
      <p className="text-muted-foreground text-sm">
        {i18n._({ id: 'app.scan.probe.checking', message: 'Checking this device…' })}
      </p>
    )
  }

  const [arLabel, arTone] = support(browser.webxr.immersiveAr)
  const [orientationLabel, orientationTone] = permission(
    browser.orientation.api,
    browser.orientation.permission,
  )
  const [motionLabel, motionTone] = permission(browser.motion.api, browser.motion.permission)
  const depthSupport = browser.webxr.features['depth-sensing']

  return (
    <div className="space-y-3">
      <dl className="divide-y divide-border/50">
        <Row
          label={i18n._({ id: 'app.scan.probe.secureContext', message: 'Secure connection' })}
          tone={browser.secureContext ? 'good' : 'bad'}
          value={
            browser.secureContext
              ? i18n._({ id: 'app.scan.probe.yes', message: 'Yes' })
              : i18n._({ id: 'app.scan.probe.noSecureContext', message: 'No: open over HTTPS' })
          }
        />
        <Row
          label={i18n._({ id: 'app.scan.probe.camera', message: 'Camera' })}
          tone={browser.camera.mediaDevices ? 'good' : 'bad'}
          value={
            browser.camera.mediaDevices
              ? browser.camera.videoInputs === null
                ? i18n._({ id: 'app.scan.probe.available', message: 'Available' })
                : i18n._({
                    id: 'app.scan.probe.cameraCount',
                    message: '{count, plural, one {# camera} other {# cameras}}',
                    values: { count: browser.camera.videoInputs },
                  })
              : i18n._({ id: 'app.scan.probe.unavailable', message: 'Not available' })
          }
        />
        <Row
          label={i18n._({ id: 'app.scan.probe.webxr', message: 'WebXR AR session' })}
          tone={arTone}
          value={arLabel}
        />
        {depthSupport ? (
          <Row
            label={i18n._({ id: 'app.scan.probe.webxrDepth', message: 'WebXR depth sensing' })}
            tone={support(depthSupport)[1]}
            value={support(depthSupport)[0]}
          />
        ) : null}
        <Row
          label={i18n._({ id: 'app.scan.probe.orientation', message: 'Orientation sensor' })}
          tone={orientationTone}
          value={orientationLabel}
        />
        <Row
          label={i18n._({ id: 'app.scan.probe.motion', message: 'Motion sensor' })}
          tone={motionTone}
          value={motionLabel}
        />
        <NativeRows native={native} />
      </dl>
    </div>
  )
}

function NativeRows({ native }: { native: NativeProbe }) {
  const i18n = usePascalI18n()
  const label = i18n._({ id: 'app.scan.probe.companion', message: 'Companion app' })

  if (native.state === 'absent') {
    return (
      <Row
        label={label}
        tone="neutral"
        value={i18n._({ id: 'app.scan.probe.companionAbsent', message: 'Not detected' })}
      />
    )
  }
  if (native.state === 'probing') {
    return (
      <Row
        label={label}
        tone="neutral"
        value={i18n._({ id: 'app.scan.probe.companionProbing', message: 'Connecting…' })}
      />
    )
  }
  if (native.state === 'failed') {
    return (
      <Row
        label={label}
        tone="bad"
        value={i18n._({
          id: 'app.scan.probe.companionFailed',
          message: 'Not responding ({code})',
          values: { code: native.code },
        })}
      />
    )
  }

  const capabilities = native.capabilities
  return (
    <>
      <Row
        label={label}
        tone="good"
        value={i18n._({
          id: 'app.scan.probe.companionReady',
          message: 'Connected, app {version}, bridge v{bridge}',
          values: { bridge: native.hello.bridgeVersion, version: native.hello.appVersion },
        })}
      />
      {capabilities ? (
        <>
          <Row
            label={i18n._({ id: 'app.scan.probe.arcore', message: 'ARCore' })}
            tone={capabilities.arcore.availability.startsWith('SUPPORTED') ? 'good' : 'neutral'}
            value={capabilities.arcore.availability}
          />
          <Row
            label={i18n._({ id: 'app.scan.probe.arcoreDepth', message: 'ARCore depth' })}
            tone={capabilities.arcore.depth ? 'good' : 'neutral'}
            value={
              capabilities.arcore.depth
                ? i18n._({ id: 'app.scan.probe.supported', message: 'Supported' })
                : i18n._({ id: 'app.scan.probe.unsupported', message: 'Not supported' })
            }
          />
          <Row
            label={i18n._({ id: 'app.scan.probe.device', message: 'Device' })}
            tone="neutral"
            value={`${capabilities.device.manufacturer} ${capabilities.device.model}`}
          />
        </>
      ) : null}
    </>
  )
}
