import { describe, expect, it } from 'bun:test'
import { CaptureSessionDescriptorSchema } from '@pascal-app/core/capture'
import { resolveCaptureFrameMatrix } from './frame'
import { buildPointCloudPayloadData } from './layers/point-cloud-layer'
import { parseDeviceTrajectoryPayload } from './trajectory'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]

// ARKit and ARCore worlds are both right-handed, Y-up, metres and gravity aligned, so the viewer
// takes poses and points as they are: the `coordinateSystem` label never changes how they draw.
describe('arcore-world and arkit-world draw the same way', () => {
  it('parses the same trajectory poses', () => {
    const samples = [
      { segment: 0, timestamp: 0, transform: IDENTITY },
      { segment: 0, timestamp: 1, transform: moved },
    ]
    expect(parseDeviceTrajectoryPayload({ coordinateSystem: 'arcore-world', samples })).toEqual(
      parseDeviceTrajectoryPayload({ coordinateSystem: 'arkit-world', samples }),
    )
  })

  it('reads the same points', () => {
    const positions = [0, 1, 2, 3, 4, 5]
    const arcore = buildPointCloudPayloadData({ coordinateSystem: 'arcore-world', positions }, 100)
    const arkit = buildPointCloudPayloadData({ coordinateSystem: 'arkit-world', positions }, 100)
    expect(Array.from(arcore.positions)).toEqual(Array.from(arkit.positions))
    expect(Array.from(arcore.positions)).toEqual(positions)
  })

  it('places a world frame without a transform at the scan origin', () => {
    const descriptor = CaptureSessionDescriptorSchema.parse({
      schemaVersion: 2,
      sessionId: 's',
      state: 'ready',
      clocks: [],
      coordinateFrames: [{ id: 'world', convention: 'arcore-world' }],
      streams: [],
    })
    expect(resolveCaptureFrameMatrix(descriptor, 'world')?.toArray()).toEqual(IDENTITY)
  })
})
