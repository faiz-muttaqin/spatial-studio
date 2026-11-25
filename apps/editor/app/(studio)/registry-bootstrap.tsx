'use client'

// Loads `@pascal-app/nodes`' built-in plugin and the bundled editor plugins
// into the node registry on the client, for every page in this route group.
// Without it the registry is empty on the client (the server registers in its
// own module instance, which is unreachable from hydrated pages) and every
// `NodeRenderer` resolves to `null`. It lives here rather than in the root
// layout so pages that never mount a viewer or editor (`/scan`, `/login`)
// do not download the editor bundle. The `loaded` guard inside
// `lib/bootstrap` keeps the side effect idempotent under HMR.
import '@/lib/bootstrap'
import type { ReactNode } from 'react'

export function RegistryBootstrap({ children }: { children: ReactNode }) {
  return children
}
