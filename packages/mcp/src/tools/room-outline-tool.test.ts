import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { registerRoomOutlineTool } from './room-outline-tool'

const parse = (text: string) => {
  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

describe('solve_room_outline', () => {
  let client: Client
  beforeEach(async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerRoomOutlineTool(server)
    const [srvT, cliT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(srvT), client.connect(cliT)])
  })
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'solve_room_outline', arguments: args })
    return {
      isError: result.isError,
      body: parse((result.content as Array<{ text: string }>)[0]!.text),
    }
  }
  const rect = [
    [0, 0],
    [5, 0],
    [5, 4],
    [0, 4],
  ]

  test('corrects a rectangle from one tape and names the next wall', async () => {
    const { isError, body } = await call({
      polygon: rect,
      edges: [
        { confidence: 'high' },
        { confidence: 'low' },
        { confidence: 'high' },
        { confidence: 'low' },
      ],
      constraints: [{ type: 'distance', a: 0, b: 1, value: 5.4 }],
    })
    expect(isError).toBeFalsy()
    expect(body.edges[0].length).toBeCloseTo(5.4, 2)
    expect(body.polygon).toHaveLength(4)
    expect(body.conflicts).toEqual([])
    expect(body.measureNext.edge).not.toBe(0)
  })

  test('reports conflicting tapes', async () => {
    const { body } = await call({
      polygon: rect,
      constraints: [
        { type: 'distance', a: 0, b: 1, value: 5 },
        { type: 'distance', a: 2, b: 3, value: 6 },
        { type: 'equalLength', edgeA: 0, edgeB: 2 },
      ],
    })
    expect(body.conflicts.length).toBeGreaterThan(0)
    expect(body.conflicts[0].message).toMatch(/corners|Edges/)
    expect(body.converged).toBe(true)
  })

  test('refuses a corner that does not exist', async () => {
    const { isError, body } = await call({
      polygon: rect,
      constraints: [{ type: 'rightAngle', corner: 9 }],
    })
    expect(isError).toBe(true)
    expect(body.code).toBe('invalid_outline')
  })

  test('refuses coordinates beyond 100 km and reports a touching outline', async () => {
    const huge = await call({
      polygon: [
        [0, 0],
        [1e200, 0],
        [1e200, 4],
        [0, 4],
      ],
    })
    expect(huge.isError).toBe(true)
    const touching = await call({
      polygon: [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
      ],
    })
    expect(touching.body.selfIntersecting).toBe(true)
  })
})
