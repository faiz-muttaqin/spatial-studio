import { describe, expect, test } from 'bun:test'
import {
  fitBounds,
  levelToScreen,
  MAX_SCALE,
  northScreenAngle,
  scaleBar,
  screenToLevel,
  zoomAt,
} from './map-view-math'
import { buildingRotationOf, captureScans, overlayBounds, sceneOverlays } from './scene-overlays'

describe('map viewport', () => {
  const view = { offsetX: 100, offsetY: 50, scale: 40, rotationDeg: 0 }
  test('level +x goes right and +z goes down, like the 2D plan', () => {
    const [x0, y0] = levelToScreen(view, 0, 0)
    const [x1, y1] = levelToScreen(view, 1, 2)
    expect(x1 - x0).toBe(40)
    expect(y1 - y0).toBe(80)
  })
  test('screenToLevel inverts levelToScreen', () => {
    const [sx, sy] = levelToScreen(view, 3.25, -1.5)
    const [x, z] = screenToLevel(view, sx, sy)
    expect(x).toBeCloseTo(3.25, 9)
    expect(z).toBeCloseTo(-1.5, 9)
  })
  test('zoom keeps the point under the cursor fixed and clamps', () => {
    const before = screenToLevel(view, 300, 200)
    const zoomed = zoomAt(view, 300, 200, 2)
    const after = screenToLevel(zoomed, 300, 200)
    expect(after[0]).toBeCloseTo(before[0], 9)
    expect(after[1]).toBeCloseTo(before[1], 9)
    expect(zoomAt(view, 0, 0, 1e9).scale).toBe(MAX_SCALE)
  })
  test('a turned view rotates clockwise about the level origin, as the 2D plan does', () => {
    const turned = { offsetX: 0, offsetY: 0, scale: 10, rotationDeg: 90 }
    // SVG rotate(90): +x goes to +y (down the screen).
    const [sx, sy] = levelToScreen(turned, 1, 0)
    expect(sx).toBeCloseTo(0, 9)
    expect(sy).toBeCloseTo(10, 9)
    const [x, z] = screenToLevel(turned, sx, sy)
    expect(x).toBeCloseTo(1, 9)
    expect(z).toBeCloseTo(0, 9)
    const zoomed = zoomAt({ ...turned, offsetX: 30, offsetY: 20 }, 80, 60, 3)
    const before = screenToLevel({ ...turned, offsetX: 30, offsetY: 20 }, 80, 60)
    const after = screenToLevel(zoomed, 80, 60)
    expect(after[0]).toBeCloseTo(before[0], 9)
    expect(after[1]).toBeCloseTo(before[1], 9)
  })
  test('fitBounds of a turned view keeps all corners inside the screen', () => {
    const bounds = { minX: -3, minZ: -2, maxX: 5, maxZ: 4 }
    const fitted = fitBounds(bounds, 500, 400, 37, 20)
    for (const x of [bounds.minX, bounds.maxX]) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        const [sx, sy] = levelToScreen(fitted, x, z)
        expect(sx).toBeGreaterThanOrEqual(19.999)
        expect(sx).toBeLessThanOrEqual(480.001)
        expect(sy).toBeGreaterThanOrEqual(19.999)
        expect(sy).toBeLessThanOrEqual(380.001)
      }
    }
  })
  test('fitBounds centres the bounds', () => {
    const fitted = fitBounds({ minX: 0, minZ: 0, maxX: 4, maxZ: 2 }, 400, 300, 0, 0)
    const [cx, cy] = levelToScreen(fitted, 2, 1)
    expect(cx).toBeCloseTo(200, 6)
    expect(cy).toBeCloseTo(150, 6)
  })
  test('the scale bar is a round number of metres', () => {
    for (const scale of [7, 33, 120, 900]) {
      const { metres, pixels } = scaleBar(scale)
      expect([1, 2, 5]).toContain(
        Number((metres / 10 ** Math.floor(Math.log10(metres))).toFixed(6)),
      )
      expect(pixels).toBeCloseTo(metres * scale, 9)
    }
  })
  test('north arrow angle is clockwise from up', () => {
    expect(northScreenAngle([0, -1])).toBeCloseTo(0, 9)
    expect(northScreenAngle([1, 0])).toBeCloseTo(90, 9)
    expect(Math.abs(northScreenAngle([0, 1]))).toBeCloseTo(180, 9)
  })
  test('the arrow follows the scene turn', () => {
    expect(northScreenAngle([0, -1], 90)).toBeCloseTo(90, 9)
    expect(northScreenAngle([1, 0], -90)).toBeCloseTo(0, 9)
  })
})

describe('scene overlays', () => {
  const nodes = {
    level_1: { id: 'level_1', type: 'level' },
    wall_a: {
      id: 'wall_a',
      type: 'wall',
      parentId: 'level_1',
      start: [0, 0],
      end: [4, 0],
      thickness: 0.2,
    },
    wall_b: { id: 'wall_b', type: 'wall', parentId: 'level_2', start: [9, 9], end: [9, 10] },
    zone_a: {
      id: 'zone_a',
      type: 'zone',
      parentId: 'level_1',
      name: 'Hall',
      polygon: [
        [0, 0],
        [4, 0],
        [4, 3],
      ],
    },
    scan_a: {
      id: 'scan_a',
      type: 'scan',
      name: 'Scan',
      parentId: 'level_1',
      position: [1, 0, 2],
      rotation: [0, 0, 0],
      scale: 1,
      captureSession: {
        sessionId: 's',
        schemaVersion: 2,
        manifestUrl: '/api/artifacts/' + 'a'.repeat(64),
      },
    },
    scan_b: { id: 'scan_b', type: 'scan', parentId: 'level_1', captureSession: null },
  }
  test('walls and zones of one level keep level coordinates untouched', () => {
    const overlays = sceneOverlays(nodes, 'level_1')
    expect(overlays.walls).toEqual([{ id: 'wall_a', a: [0, 0], b: [4, 0], thickness: 0.2 }])
    expect(overlays.zones[0]!.polygon).toEqual([
      [0, 0],
      [4, 0],
      [4, 3],
    ])
  })
  test('only scans with a capture manifest are listed', () => {
    const scans = captureScans(nodes)
    expect(scans.map((scan) => scan.id)).toEqual(['scan_a'])
    expect(scans[0]!.transform.position).toEqual([1, 0, 2])
  })
  test('hidden walls, zones and scans are skipped', () => {
    const hidden = {
      ...nodes,
      wall_h: {
        id: 'wall_h',
        type: 'wall',
        parentId: 'level_1',
        start: [0, 0],
        end: [1, 1],
        visible: false,
      },
      zone_h: {
        id: 'zone_h',
        type: 'zone',
        parentId: 'level_1',
        polygon: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        visible: false,
      },
    }
    const overlays = sceneOverlays(hidden, 'level_1')
    expect(overlays.walls.map((wall) => wall.id)).toEqual(['wall_a'])
    expect(overlays.zones.map((zone) => zone.id)).toEqual(['zone_a'])
    expect(captureScans({ s: { ...nodes.scan_a, visible: false } })).toEqual([])
  })
  test('the building turn is read from the level parent', () => {
    const turned = {
      building_1: { id: 'building_1', type: 'building', rotation: [0, 0.5, 0] },
      level_1: { id: 'level_1', type: 'level', parentId: 'building_1' },
    }
    expect(buildingRotationOf(turned, 'level_1')).toBe(0.5)
    expect(buildingRotationOf(turned, null)).toBe(0)
    expect(buildingRotationOf(nodes, 'level_1')).toBe(0)
  })
  test('bounds', () => {
    expect(
      overlayBounds([
        [1, 2],
        [3, -1],
      ]),
    ).toEqual({ minX: 1, minZ: -1, maxX: 3, maxZ: 2 })
    expect(overlayBounds([])).toBeNull()
  })
})
