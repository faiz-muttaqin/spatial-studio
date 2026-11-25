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
