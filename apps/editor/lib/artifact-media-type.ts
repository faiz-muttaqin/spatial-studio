const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

const GLTF_BINARY = [0x67, 0x6c, 0x54, 0x46] // "glTF"
const JPEG = [0xff, 0xd8, 0xff]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RIFF = [0x52, 0x49, 0x46, 0x46] // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50] // "WEBP"

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false
  return prefix.every((byte, index) => bytes[offset + index] === byte)
}

function isJson(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    // JSON whitespace: space, tab, LF, CR.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x7b || byte === 0x5b // "{" or "["
  }
  return false
}

/**
 * The Content-Type for stored artifact bytes, detected from their magic bytes.
 * Only the types listed here are ever returned: HTML, SVG and other script-capable
 * types are deliberately absent, so they fall through to `text/plain`.
 */
export function artifactMediaType(bytes: Uint8Array): string {
  if (startsWith(bytes, GLTF_BINARY)) return 'model/gltf-binary'
  if (startsWith(bytes, JPEG)) return 'image/jpeg'
  if (startsWith(bytes, PNG)) return 'image/png'
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp'
  if (isJson(bytes)) return JSON_TYPE
  return TEXT
}
