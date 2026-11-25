import { expect, test } from 'bun:test'
import {
  CaptureSessionDescriptorSchema,
  type CaptureSource,
  type CaptureStreamDescriptor,
} from '@pascal-app/core/capture'
import { create } from '@react-three/test-renderer'
import { type CaptureSourceState, useCaptureSource } from './source-state'

const descriptor = CaptureSessionDescriptorSchema.parse({
  schemaVersion: 2,
  sessionId: 's',
  state: 'ready',
  clocks: [],
  coordinateFrames: [],
  streams: [{ id: 'points', kind: 'point-cloud', inline: { positions: [0, 0, 0] } }],
})

test('a new stream filter does not reload the capture descriptor', async () => {
  let describes = 0
  const source: CaptureSource = {
    describe: async () => {
      describes += 1
      return descriptor
    },
  }
  const locator = { sessionId: 's' }
  const resolve = () => source
  let latest: CaptureSourceState | null = null
  function Probe({ filter }: { filter: (stream: CaptureStreamDescriptor) => boolean }) {
    latest = useCaptureSource(locator, resolve, { streamFilter: filter })
    return null
  }
  const view = await create(<Probe filter={() => true} />)
  await Promise.resolve()
  await Promise.resolve()
  expect(latest?.descriptor).not.toBeNull()
  await view.update(<Probe filter={() => false} />)
  await Promise.resolve()
  expect(latest?.descriptor).not.toBeNull()
  expect(describes).toBe(1)
})
