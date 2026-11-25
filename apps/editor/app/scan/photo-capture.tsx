'use client'

import { CAPTURE_MAX_KEYFRAMES } from '@pascal-app/core/capture'
import { usePascalI18n } from '@pascal-app/core/i18n'
import { Camera, ImagePlus, X } from 'lucide-react'
import { type ChangeEvent, useRef } from 'react'
import { SECONDARY_PILL } from '@/components/app-shell'

export type CapturedPhoto = {
  id: string
  previewUrl: string
  width: number
  height: number
  byteLength: number
}

export function PhotoCapture({
  photos,
  processing,
  disabled,
  onFiles,
  onRemove,
}: {
  photos: readonly CapturedPhoto[]
  processing: number
  disabled: boolean
  onFiles: (files: File[]) => void
  onRemove: (id: string) => void
}) {
  const i18n = usePascalI18n()
  const cameraInput = useRef<HTMLInputElement>(null)
  const libraryInput = useRef<HTMLInputElement>(null)
  const full = photos.length + processing >= CAPTURE_MAX_KEYFRAMES

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) onFiles(files)
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        {i18n._({
          id: 'app.scan.photos.hint',
          message:
            'Photograph each wall, corner, door and window. Photos are resized to 1920 px and their location data is removed before upload.',
        })}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button
          className={`${SECONDARY_PILL} h-11`}
          disabled={disabled || full}
          onClick={() => cameraInput.current?.click()}
          type="button"
        >
          <Camera className="h-4 w-4" />
          {i18n._({ id: 'app.scan.photos.take', message: 'Take photo' })}
        </button>
        <button
          className={`${SECONDARY_PILL} h-11`}
          disabled={disabled || full}
          onClick={() => libraryInput.current?.click()}
          type="button"
        >
          <ImagePlus className="h-4 w-4" />
          {i18n._({ id: 'app.scan.photos.choose', message: 'Choose photos' })}
        </button>
      </div>
      <input
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleChange}
        ref={cameraInput}
        type="file"
      />
      <input
        accept="image/*"
        className="hidden"
        multiple
        onChange={handleChange}
        ref={libraryInput}
        type="file"
      />
      <p className="text-muted-foreground text-xs" data-testid="scan-photo-count">
        {i18n._({
          id: 'app.scan.photos.count',
          message: '{count} of {max} photos',
          values: { count: photos.length, max: CAPTURE_MAX_KEYFRAMES },
        })}
        {processing > 0
          ? ` · ${i18n._({
              id: 'app.scan.photos.processing',
              message: 'preparing {count}…',
              values: { count: processing },
            })}`
          : ''}
      </p>
      {photos.length > 0 ? (
        <ul className="grid grid-cols-3 gap-2">
          {photos.map((photo, index) => (
            <li
              className="relative aspect-square overflow-hidden rounded-lg bg-muted"
              key={photo.id}
            >
              <img
                alt={i18n._({
                  id: 'app.scan.photos.alt',
                  message: 'Photo {number}',
                  values: { number: index + 1 },
                })}
                className="h-full w-full object-cover"
                src={photo.previewUrl}
              />
              <button
                aria-label={i18n._({
                  id: 'app.scan.photos.remove',
                  message: 'Remove photo {number}',
                  values: { number: index + 1 },
                })}
                className="absolute top-1 right-1 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white disabled:opacity-50"
                disabled={disabled}
                onClick={() => onRemove(photo.id)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
