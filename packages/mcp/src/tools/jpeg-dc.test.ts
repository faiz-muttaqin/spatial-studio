import { describe, expect, test } from 'bun:test'
import { decodeJpegDc } from './jpeg-dc'

// 64 x 32 test images made with sharp: red top-left, green bottom-left, blue top-right, yellow
// bottom-right (quality 90). Regenerate with any encoder that writes baseline JPEG.
const FIXTURES = {
  i420: '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgAEADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABcBAQEBAQAAAAAAAAAAAAAAAAAICQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCJAOVL9AASEBqkzaAAbQAY2pqAAa+AcRXkAA//2Q==',
  i444: '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgAEADAREAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABcBAQEBAQAAAAAAAAAAAAAAAAAJCAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCJOVN+gAAJCqkm0AAAryVqkoAACQqpJtAAANoI2s1AAANfOIt5AAAMgu3MGgAANfOIt5AAAP/Z',
  gray: '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgAEADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAcGCf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AygAAAIkAAADogAAAC4AAAA//2Q==',
  prog: '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAgAEADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAUG/8QAFwEBAQEBAAAAAAAAAAAAAAAAAAYFB//aAAwDAQACEAMQAAABhjMtgJA6TAAbQcpnwNeMe0A//8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQABBQID/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAwEBPwEP/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAgEBPwEP/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQAGPwID/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQABPyED/9oADAMBAAIAAwAAABD/AP8A/wD33/8A/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAwEBPxAP/8QAFBEBAAAAAAAAAAAAAAAAAAAAMP/aAAgBAgEBPxAP/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQABPxAD/9k=',
}
const bytes = (name: keyof typeof FIXTURES) => new Uint8Array(Buffer.from(FIXTURES[name], 'base64'))

function pixel(image: NonNullable<ReturnType<typeof decodeJpegDc>>, x: number, y: number) {
  const at = (y * image.width + x) * 3
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!]
}

function close(actual: number[], expected: number[], tolerance = 25) {
  for (let c = 0; c < 3; c += 1)
    expect(Math.abs(actual[c]! - expected[c]!)).toBeLessThanOrEqual(tolerance)
}

describe('decodeJpegDc', () => {
  for (const name of ['i420', 'i444'] as const) {
    test(`${name}: one pixel per 8x8 block, quadrant colours in the right places`, () => {
      const image = decodeJpegDc(bytes(name))!
      expect(image.width).toBe(8)
      expect(image.height).toBe(4)
      expect(image.sourceWidth).toBe(64)
      expect(image.sourceHeight).toBe(32)
      // Blocks away from the edges between quadrants, where 4:2:0 chroma is shared.
      close(pixel(image, 1, 0), [220, 30, 30], 45)
      close(pixel(image, 1, 3), [30, 200, 30], 45)
      close(pixel(image, 6, 0), [30, 30, 220], 45)
      close(pixel(image, 6, 3), [230, 220, 30], 45)
    })
  }

  test('a grey scale image decodes to equal channels', () => {
    const image = decodeJpegDc(bytes('gray'))!
    const [r, g, b] = pixel(image, 1, 0)
    expect(r).toBe(g)
    expect(g).toBe(b)
  })

  test('a progressive or truncated file is refused, not misread', () => {
    expect(decodeJpegDc(bytes('prog'))).toBeNull()
    expect(decodeJpegDc(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
    expect(decodeJpegDc(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})
