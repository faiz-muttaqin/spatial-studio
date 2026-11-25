import { expect, test } from 'bun:test'
import { artifactMediaType } from './artifact-media-type'

const bytesOf = (...values: number[]) => new Uint8Array(values)
const ascii = (text: string) => new TextEncoder().encode(text)

test('glTF binary, JPEG, PNG and WebP are detected by magic bytes', () => {
  expect(artifactMediaType(ascii('glTF\x02\x00\x00\x00'))).toBe('model/gltf-binary')
  expect(artifactMediaType(bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00))).toBe('image/jpeg')
  expect(artifactMediaType(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe(
    'image/png',
  )
  expect(artifactMediaType(ascii('RIFF\x24\x00\x00\x00WEBPVP8 '))).toBe('image/webp')
})

test('JSON objects and arrays are detected, including after leading whitespace', () => {
  expect(artifactMediaType(ascii('{"frames":[]}'))).toBe('application/json; charset=utf-8')
  expect(artifactMediaType(ascii('[1,2,3]'))).toBe('application/json; charset=utf-8')
  expect(artifactMediaType(ascii(' \t\r\n  {"a":1}'))).toBe('application/json; charset=utf-8')
})

test('empty input is plain text', () => {
  expect(artifactMediaType(new Uint8Array(0))).toBe('text/plain; charset=utf-8')
})

test('short input that cannot match a signature is plain text', () => {
  expect(artifactMediaType(bytesOf(0xff, 0xd8))).toBe('text/plain; charset=utf-8')
  expect(artifactMediaType(ascii('glT'))).toBe('text/plain; charset=utf-8')
  expect(artifactMediaType(ascii('RIFF'))).toBe('text/plain; charset=utf-8')
  expect(artifactMediaType(bytesOf(0x89, 0x50, 0x4e, 0x47))).toBe('text/plain; charset=utf-8')
})

test('whitespace only, or whitespace before a non-JSON byte, is plain text', () => {
  expect(artifactMediaType(ascii('   \n'))).toBe('text/plain; charset=utf-8')
  expect(artifactMediaType(ascii('  hello'))).toBe('text/plain; charset=utf-8')
})

test('RIFF containers that are not WebP are plain text', () => {
  expect(artifactMediaType(ascii('RIFF\x24\x00\x00\x00WAVEfmt '))).toBe('text/plain; charset=utf-8')
})

test('HTML and SVG never get a script-capable type', () => {
  expect(artifactMediaType(ascii('<!doctype html><script>alert(1)</script>'))).toBe(
    'text/plain; charset=utf-8',
  )
  expect(artifactMediaType(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
    'text/plain; charset=utf-8',
  )
  expect(artifactMediaType(ascii('  <?xml version="1.0"?><svg></svg>'))).toBe(
    'text/plain; charset=utf-8',
  )
})
