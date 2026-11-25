import { CAPTURE_MAX_IMAGE_LONG_EDGE } from '@pascal-app/core/capture'

export function fitLongEdge(
  width: number,
  height: number,
  maxEdge: number = CAPTURE_MAX_IMAGE_LONG_EDGE,
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxEdge) return { width, height }
  const scale = maxEdge / longEdge
  return {
    width: Math.max(1, Math.min(maxEdge, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxEdge, Math.round(height * scale))),
  }
}

/**
 * Decodes a photo (EXIF orientation applied), scales its long edge to the
 * contract bound and re-encodes it as JPEG. Re-encoding also drops the EXIF
 * block, so GPS tags and device serials never reach the store.
 */
export async function downscaleToJpeg(
  file: Blob,
  options: { maxEdge?: number; quality?: number } = {},
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { width, height } = fitLongEdge(bitmap.width, bitmap.height, options.maxEdge)
    const quality = options.quality ?? 0.85
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('2D canvas is unavailable.')
      context.drawImage(bitmap, 0, 0, width, height)
      return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality }), width, height }
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas is unavailable.')
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('JPEG encoding failed.'))),
        'image/jpeg',
        quality,
      ),
    )
    return { blob, width, height }
  } finally {
    bitmap.close()
  }
}
