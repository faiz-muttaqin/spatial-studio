import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type AnyNode,
  type AnyNodeId,
  BuildingNode,
  LevelNode,
  ScanNode,
  useScene,
} from '@pascal-app/core'
import { buildRoomFromOutline } from './build-room'

const SQUARE: Array<[number, number]> = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
]

function load() {
  const scan = ScanNode.parse({ id: 'scan_t1', parentId: 'level_t1' })
  const level = LevelNode.parse({ id: 'level_t1', parentId: 'building_t1', children: [scan.id] })
  const building = BuildingNode.parse({ id: 'building_t1', children: [level.id] })
  useScene
    .getState()
    .setScene(
      Object.fromEntries([building, level, scan].map((node) => [node.id, node as AnyNode])),
      [building.id as AnyNodeId],
    )
}

describe('buildRoomFromOutline', () => {
  beforeEach(load)

  test('builds walls and a zone on the level and moves the scan in one undo step', () => {
    const result = buildRoomFromOutline({
      levelId: 'level_t1',
      name: 'Room',
      polygon: SQUARE,
      height: 2.7,
      scan: { id: 'scan_t1', transform: { position: [0, -0.2, 0], rotation: [0, 0, 0], scale: 1 } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.wallCount).toBe(4)
    expect(result.slabId).not.toBeNull()
    expect(result.ceilingId).not.toBeNull()
    expect(result.areaSqMeters).toBeCloseTo(12, 1)
    const nodes = Object.values(useScene.getState().nodes)
    const walls = nodes.filter((node) => node.type === 'wall')
    expect(walls).toHaveLength(4)
    expect(nodes.filter((node) => node.type === 'slab')).toHaveLength(1)
    expect(nodes.filter((node) => node.type === 'ceiling')).toHaveLength(1)
    expect(nodes.filter((node) => node.type === 'zone')).toHaveLength(1)
    expect(walls.every((wall) => wall.parentId === 'level_t1')).toBe(true)
    expect(walls.every((wall) => (wall as { height?: number }).height === 2.7)).toBe(true)
    expect((useScene.getState().nodes['scan_t1' as AnyNodeId] as ScanNode).position[1]).toBe(-0.2)
    useScene.temporal.getState().undo()
    expect(Object.values(useScene.getState().nodes).filter((n) => n.type === 'zone')).toHaveLength(
      0,
    )
    expect(Object.values(useScene.getState().nodes).filter((n) => n.type === 'slab')).toHaveLength(
      0,
    )
    expect(Object.values(useScene.getState().nodes).filter((n) => n.type === 'wall')).toHaveLength(
      0,
    )
    expect((useScene.getState().nodes['scan_t1' as AnyNodeId] as ScanNode).position[1]).toBe(0)
  })

  test('a second build over the same walls is refused and adds no second room', () => {
    const first = buildRoomFromOutline({
      levelId: 'level_t1',
      name: 'Room',
      polygon: SQUARE,
      height: 2.7,
    })
    expect(first.ok).toBe(true)
    const second = buildRoomFromOutline({
      levelId: 'level_t1',
      name: 'Room',
      polygon: SQUARE,
      height: 2.7,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('room_named_by_person')
    expect(Object.values(useScene.getState().nodes).filter((n) => n.type === 'zone')).toHaveLength(
      1,
    )
  })

  test('refuses a polygon that is not a room and writes nothing', () => {
    const result = buildRoomFromOutline({
      levelId: 'level_t1',
      name: 'Room',
      polygon: [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
      height: 2.5,
    })
    expect(result.ok).toBe(false)
    expect(Object.values(useScene.getState().nodes).filter((n) => n.type === 'wall')).toHaveLength(
      0,
    )
  })
})
