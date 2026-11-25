/**
 * A tiny baseline JPEG reader that returns one pixel per 8x8 block (the DC coefficients), which is
 * an exact 1/8 scale image without an inverse DCT. It exists so the scan map can read keyframe
 * colours in Node with no image dependency; a browser adapter would use `createImageBitmap`
 * instead and hand the same `RgbImage` to core.
 *
 * Supports baseline (SOF0) and extended sequential (SOF1) Huffman JPEG with 1 or 3 components in
 * one interleaved scan, any sampling factors up to 4x4, restart intervals, JFIF YCbCr. Progressive,
 * arithmetic and multi-scan files return null.
 */
import type { RgbImage } from '@pascal-app/core/capture'

type Huffman = { maxCode: Int32Array; valPtr: Int32Array; minCode: Int32Array; values: Uint8Array }

type Component = {
  id: number
  h: number
  v: number
  quantTable: number
  dcTable: number
  acTable: number
  /** DC samples, `blocksX` x `blocksY` (padded to whole MCUs). */
  dc: Float32Array
  blocksX: number
  blocksY: number
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxCode = new Int32Array(18).fill(-1)
  const valPtr = new Int32Array(17)
  const minCode = new Int32Array(17)
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length += 1) {
    valPtr[length] = k
    minCode[length] = code
    code += counts[length - 1]!
    k += counts[length - 1]!
    maxCode[length] = counts[length - 1]! > 0 ? code - 1 : -1
    code <<= 1
  }
  return { maxCode, valPtr, minCode, values }
}

/** Pixels per block edge: the decoded image is `ceil(width / 8)` x `ceil(height / 8)`. */
export const JPEG_DC_SCALE = 8

export function decodeJpegDc(
  bytes: Uint8Array,
): (RgbImage & { sourceWidth: number; sourceHeight: number }) | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const quant: Array<Uint16Array | undefined> = []
  const dcTables: Array<Huffman | undefined> = []
  const acTables: Array<Huffman | undefined> = []
  let components: Component[] = []
  let width = 0
  let height = 0
  let restartInterval = 0
  let position = 2
  let scanStart = -1
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) {
      position += 1
      continue
    }
    const marker = bytes[position + 1]!
    if (marker === 0xff) {
      position += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      position += 2
      continue
    }
    if (marker === 0xd9) break
    const length = (bytes[position + 2]! << 8) | bytes[position + 3]!
    const body = position + 4
    const end = position + 2 + length
    if (end > bytes.length) return null
    if (marker === 0xdb) {
      let at = body
      while (at < end) {
        const info = bytes[at]!
        const precision = info >> 4
        const table = new Uint16Array(64)
        for (let i = 0; i < 64; i += 1) {
          table[i] = precision
            ? (bytes[at + 1 + i * 2]! << 8) | bytes[at + 2 + i * 2]!
            : bytes[at + 1 + i]!
        }
        quant[info & 15] = table
        at += 1 + 64 * (precision ? 2 : 1)
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      height = (bytes[body + 1]! << 8) | bytes[body + 2]!
      width = (bytes[body + 3]! << 8) | bytes[body + 4]!
      const count = bytes[body + 5]!
      if (bytes[body] !== 8 || (count !== 1 && count !== 3) || !width || !height) return null
      components = []
      for (let i = 0; i < count; i += 1) {
        const at = body + 6 + i * 3
        const h = bytes[at + 1]! >> 4
        const v = bytes[at + 1]! & 15
        if (h < 1 || h > 4 || v < 1 || v > 4) return null
        components.push({
          id: bytes[at]!,
          h,
          v,
          quantTable: bytes[at + 2]!,
          dcTable: 0,
          acTable: 0,
          dc: new Float32Array(0),
          blocksX: 0,
          blocksY: 0,
        })
      }
    } else if (
      marker === 0xc2 ||
      (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
    ) {
      return null // progressive, lossless or arithmetic
    } else if (marker === 0xc4) {
      let at = body
      while (at < end) {
        const info = bytes[at]!
        const counts = bytes.subarray(at + 1, at + 17)
        const total = counts.reduce((sum, value) => sum + value, 0)
        const values = bytes.slice(at + 17, at + 17 + total)
        const table = buildHuffman(counts, values)
        if (info >> 4) acTables[info & 15] = table
        else dcTables[info & 15] = table
        at += 17 + total
      }
    } else if (marker === 0xdd) {
      restartInterval = (bytes[body]! << 8) | bytes[body + 1]!
    } else if (marker === 0xda) {
      const count = bytes[body]!
      if (count !== components.length) return null
      for (let i = 0; i < count; i += 1) {
        const component = components.find((candidate) => candidate.id === bytes[body + 1 + i * 2])
        if (!component) return null
        const tables = bytes[body + 2 + i * 2]!
        component.dcTable = tables >> 4
        component.acTable = tables & 15
      }
      scanStart = end
      break
    }
    position = end
  }
  if (scanStart < 0 || components.length === 0) return null

  const hMax = Math.max(...components.map((component) => component.h))
  const vMax = Math.max(...components.map((component) => component.v))
  const single = components.length === 1
  // A single-component scan is not interleaved: its blocks run over the image in 8x8 steps.
  const mcusX = single ? Math.ceil(width / 8) : Math.ceil(width / (8 * hMax))
  const mcusY = single ? Math.ceil(height / 8) : Math.ceil(height / (8 * vMax))
  for (const component of components) {
    component.blocksX = single ? mcusX : mcusX * component.h
    component.blocksY = single ? mcusY : mcusY * component.v
    component.dc = new Float32Array(component.blocksX * component.blocksY)
  }

  // Bit reader over the entropy-coded data, undoing 0xFF00 stuffing and stopping at markers.
  let at = scanStart
  let bitBuffer = 0
  let bitCount = 0
  let hitMarker = false
  const readBit = (): number => {
    if (bitCount === 0) {
      if (hitMarker || at >= bytes.length) return 0
      let byte = bytes[at++]!
      if (byte === 0xff) {
        const next = bytes[at]!
        if (next === 0) at += 1
        else {
          hitMarker = true
          at -= 1
          byte = 0
        }
      }
      bitBuffer = byte
      bitCount = 8
    }
    bitCount -= 1
    return (bitBuffer >> bitCount) & 1
  }
  const receive = (size: number): number => {
    let value = 0
    for (let i = 0; i < size; i += 1) value = (value << 1) | readBit()
    return value
  }
  const extend = (value: number, size: number): number =>
    size === 0 ? 0 : value < 1 << (size - 1) ? value - (1 << size) + 1 : value
  const decode = (table: Huffman): number => {
    let code = 0
    for (let length = 1; length <= 16; length += 1) {
      code = (code << 1) | readBit()
      const max = table.maxCode[length]!
      if (max >= 0 && code <= max && code >= table.minCode[length]!) {
        return table.values[table.valPtr[length]! + code - table.minCode[length]!]!
      }
    }
    return 0
  }

  const predictions = new Int32Array(components.length)
  const readBlock = (index: number, blockX: number, blockY: number): boolean => {
    const component = components[index]!
    const dcTable = dcTables[component.dcTable]
    const acTable = acTables[component.acTable]
    if (!dcTable || !acTable) return false
    const size = decode(dcTable)
    predictions[index] = predictions[index]! + extend(receive(size), size)
    const q = quant[component.quantTable]?.[0] ?? 1
    // DC-only inverse DCT: the block mean is DC / 8 (times the quantiser), level-shifted by 128.
    component.dc[blockY * component.blocksX + blockX] = (predictions[index]! * q) / 8 + 128
    for (let k = 1; k < 64; ) {
      const symbol = decode(acTable)
      const run = symbol >> 4
      const bits = symbol & 15
      if (bits === 0) {
        if (run === 15) k += 16
        else break
      } else {
        k += run
        receive(bits)
        k += 1
      }
    }
    return true
  }

  let restartCount = 0
  const total = mcusX * mcusY
  for (let mcu = 0; mcu < total; mcu += 1) {
    if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
      // Skip to the RSTn marker and reset the predictions.
      bitCount = 0
      hitMarker = false
      while (
        at + 1 < bytes.length &&
        !(bytes[at] === 0xff && bytes[at + 1]! >= 0xd0 && bytes[at + 1]! <= 0xd7)
      )
        at += 1
      at += 2
      predictions.fill(0)
      restartCount += 1
    }
    const mx = mcu % mcusX
    const my = Math.floor(mcu / mcusX)
    if (single) {
      if (!readBlock(0, mx, my)) return null
    } else {
      for (let c = 0; c < components.length; c += 1) {
        const component = components[c]!
        for (let by = 0; by < component.v; by += 1) {
          for (let bx = 0; bx < component.h; bx += 1) {
            if (!readBlock(c, mx * component.h + bx, my * component.v + by)) return null
          }
        }
      }
    }
    if (hitMarker && bitCount === 0 && at >= bytes.length) break
  }
  void restartCount

  const outWidth = Math.ceil(width / 8)
  const outHeight = Math.ceil(height / 8)
  const data = new Uint8Array(outWidth * outHeight * 3)
  const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value))
  const luma = components[0]!
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const sample = (component: Component) => {
        const sx = single
          ? x
          : Math.min(component.blocksX - 1, Math.floor((x * component.h) / hMax))
        const sy = single
          ? y
          : Math.min(component.blocksY - 1, Math.floor((y * component.v) / vMax))
        return component.dc[sy * component.blocksX + sx]!
      }
      const Y = sample(luma)
      const out = (y * outWidth + x) * 3
      if (single) {
        data[out] = data[out + 1] = data[out + 2] = clamp(Y)
      } else {
        const cb = sample(components[1]!) - 128
        const cr = sample(components[2]!) - 128
        data[out] = clamp(Y + 1.402 * cr)
        data[out + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr)
        data[out + 2] = clamp(Y + 1.772 * cb)
      }
    }
  }
  return {
    width: outWidth,
    height: outHeight,
    channels: 3,
    data,
    sourceWidth: width,
    sourceHeight: height,
  }
}
