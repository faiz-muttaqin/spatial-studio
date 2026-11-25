'use client'

import { usePascalI18n } from '@pascal-app/core/i18n'
import { ScanLine } from 'lucide-react'
import Link from 'next/link'
import { SECONDARY_PILL } from './app-shell'

/** Entry to `/scan`, which the Android companion and phone browsers open to capture a room. */
export function ScanRoomLink() {
  const i18n = usePascalI18n()
  return (
    <Link className={SECONDARY_PILL} href="/scan">
      <ScanLine className="h-4 w-4" />
      {i18n._({ id: 'app.scan.title', message: 'Scan a room' })}
    </Link>
  )
}
