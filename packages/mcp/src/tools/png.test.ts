import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { encodePng } from './png'

test('encodePng writes a valid RGB PNG that inflates back to the pixels', () => {
  const width = 5
  const height = 3
  const rgb = Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 37) % 256)
  const png = encodePng(width, height, rgb)
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(png.buffer, png.byteOffset)
  expect(view.getUint32(16)).toBe(width)
  expect(view.getUint32(20)).toBe(height)
  // IDAT payload starts after the 8-byte signature, the 25-byte IHDR chunk and the IDAT header.
  const idatLength = view.getUint32(33)
  expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT')
  const raw = inflateSync(png.subarray(41, 41 + idatLength))
  const decoded = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width * 3 + 1)]).toBe(1)
    for (let i = 0; i < width * 3; i += 1) {
      const left = i >= 3 ? decoded[y * width * 3 + i - 3]! : 0
      decoded[y * width * 3 + i] = (raw[y * (width * 3 + 1) + 1 + i]! + left) & 0xff
    }
  }
  expect([...decoded]).toEqual([...rgb])
  expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND')
})
