/**
 * A streamed zip with no compression ("stored"). Scan keyframes are JPEGs, so deflating them gains
 * nothing; storing them lets the archive stream one entry at a time without buffering all of it.
 * Entries hold at most 4 GiB and the archive at most 65,535 entries, so no zip64 records are needed.
 */

export type ZipEntry = { name: string; data: Uint8Array }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 1980-01-01 00:00, the zip epoch; entries carry no timestamp so the archive is reproducible. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

type CentralRecord = { name: Uint8Array; crc: number; size: number; offset: number }

function localHeader(record: CentralRecord): Uint8Array {
  const out = new Uint8Array(30 + record.name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 0x0800, true) // UTF-8 names
  view.setUint16(8, 0, true) // stored
  view.setUint16(10, DOS_TIME, true)
  view.setUint16(12, DOS_DATE, true)
  view.setUint32(14, record.crc, true)
  view.setUint32(18, record.size, true)
  view.setUint32(22, record.size, true)
  view.setUint16(26, record.name.length, true)
  out.set(record.name, 30)
  return out
}

function centralDirectory(records: readonly CentralRecord[], start: number): Uint8Array {
  const entriesSize = records.reduce((sum, record) => sum + 46 + record.name.length, 0)
  const out = new Uint8Array(entriesSize + 22)
  const view = new DataView(out.buffer)
  let at = 0
  for (const record of records) {
    view.setUint32(at, 0x02014b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, 20, true)
    view.setUint16(at + 8, 0x0800, true)
    view.setUint16(at + 10, 0, true)
    view.setUint16(at + 12, DOS_TIME, true)
    view.setUint16(at + 14, DOS_DATE, true)
    view.setUint32(at + 16, record.crc, true)
    view.setUint32(at + 20, record.size, true)
    view.setUint32(at + 24, record.size, true)
    view.setUint16(at + 28, record.name.length, true)
    view.setUint32(at + 42, record.offset, true)
    out.set(record.name, at + 46)
    at += 46 + record.name.length
  }
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, records.length, true)
  view.setUint16(at + 10, records.length, true)
  view.setUint32(at + 12, entriesSize, true)
  view.setUint32(at + 16, start, true)
  return out
}

/** The archive as a stream; `entries` is pulled one entry at a time. */
export function zipStoreStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): ReadableStream<Uint8Array> {
  const iterator =
    Symbol.asyncIterator in entries
      ? (entries as AsyncIterable<ZipEntry>)[Symbol.asyncIterator]()
      : (entries as Iterable<ZipEntry>)[Symbol.iterator]()
  const encoder = new TextEncoder()
  const records: CentralRecord[] = []
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) {
        controller.enqueue(centralDirectory(records, offset))
        controller.close()
        return
      }
      const { name, data } = next.value
      const record: CentralRecord = {
        name: encoder.encode(name),
        crc: crc32(data),
        size: data.length,
        offset,
      }
      records.push(record)
      const header = localHeader(record)
      controller.enqueue(header)
      controller.enqueue(data)
      offset += header.length + data.length
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}
