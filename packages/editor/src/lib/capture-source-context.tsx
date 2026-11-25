'use client'

import type { CaptureSourceResolver } from '@pascal-app/core/capture'
import { createContext, type ReactNode, useContext } from 'react'

const CaptureSourceResolverContext = createContext<CaptureSourceResolver | null>(null)

/** Shares the host's capture source resolver with editor panels (the 3D layers take it as a prop). */
export function CaptureSourceResolverProvider({
  children,
  value,
}: {
  children: ReactNode
  value: CaptureSourceResolver | null
}) {
  return (
    <CaptureSourceResolverContext.Provider value={value}>
      {children}
    </CaptureSourceResolverContext.Provider>
  )
}

export function useCaptureSourceResolver(): CaptureSourceResolver | null {
  return useContext(CaptureSourceResolverContext)
}

const BrushDatasetUrlContext = createContext<((scanId: string) => string) | null>(null)

/**
 * Where the host serves a scan's Brush dataset zip (`docs/spatial-studio/BRUSH_WORKFLOW.md`). The
 * editor does not know the host's scene id, so the evidence panel asks for the link; without it
 * the panel offers no download.
 */
export function BrushDatasetUrlProvider({
  children,
  value,
}: {
  children: ReactNode
  value: ((scanId: string) => string) | null
}) {
  return <BrushDatasetUrlContext.Provider value={value}>{children}</BrushDatasetUrlContext.Provider>
}

export function useBrushDatasetUrl(): ((scanId: string) => string) | null {
  return useContext(BrushDatasetUrlContext)
}
