'use client'

// Locale scope shared by every page. The node registry and editor plugins
// load from `(studio)/registry-bootstrap.tsx`, only for pages that mount a
// viewer or editor.
import { createI18n, defaultI18n, PascalI18nProvider } from '@pascal-app/core/i18n'
import { registerBundledLocales } from '@pascal-app/editor/locales'
import { type ReactNode, useEffect, useMemo } from 'react'
import { registerDevLocales } from '@/lib/dev-locales'

registerBundledLocales()
registerDevLocales()

export function ClientBootstrap({
  children,
  enableDevDiagnostics,
  locale,
}: {
  children: ReactNode
  enableDevDiagnostics: boolean
  locale: string
}) {
  const i18n = useMemo(() => createI18n({ locale }), [locale])

  useEffect(() => {
    if (!enableDevDiagnostics) return
    import('react-scan').then(({ scan }) => scan({ enabled: true }))
  }, [enableDevDiagnostics])

  useEffect(() => {
    const syncDocumentLocale = () => {
      document.documentElement.lang = i18n.getLocale()
    }
    syncDocumentLocale()
    return i18n.subscribe(syncDocumentLocale)
  }, [i18n])

  useEffect(() => {
    return defaultI18n.subscribeLocale((nextLocale) => i18n.setLocale(nextLocale))
  }, [i18n])

  return <PascalI18nProvider i18n={i18n}>{children}</PascalI18nProvider>
}
