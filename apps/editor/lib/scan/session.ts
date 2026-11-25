/** A capture session id: unique, opaque, safe in URLs and file names. */
export function newCaptureSessionId(): string {
  return `capture_${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * Scene-data name for a scan node or a project made from a scan, e.g.
 * `Room scan 2026-11-25 14:03`. Scene data is not translated.
 */
export function captureName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `Room scan ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
