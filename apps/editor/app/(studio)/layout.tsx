import type { ReactNode } from 'react'
import { RegistryBootstrap } from './registry-bootstrap'

export default function StudioLayout({ children }: { children: ReactNode }) {
  return <RegistryBootstrap>{children}</RegistryBootstrap>
}
