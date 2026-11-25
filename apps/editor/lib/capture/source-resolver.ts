import {
  type CaptureArtifactReference,
  type CaptureSessionLocator,
  type CaptureSource,
  type CaptureSourceResolver,
  createHttpCaptureSource,
} from '@pascal-app/core/capture'

type ResolverOptions = {
  /** Defaults to `location.origin`. Manifests and artifacts must live on it. */
  origin?: string
  fetch?: typeof globalThis.fetch
}

/**
 * Same-origin capture sources for the editor. A scan's manifest and every artifact it names
 * (`/api/artifacts/<sha256>`) are fetched with the session cookie, so only this origin is ever
 * contacted, and only the content-addressed artifact route: a manifest URL or artifact URI that
 * points elsewhere, to another path, or to a `blob:` or `data:` URL is refused instead of leaking
 * the cookie or loading foreign content into the scene. Sources are shared per session so the
 * 3D layers and the evidence panel read the manifest once.
 */
export function createCaptureSourceResolver(options: ResolverOptions = {}): CaptureSourceResolver {
  const sources = new Map<string, CaptureSource>()

  return (locator: CaptureSessionLocator) => {
    const origin = options.origin ?? globalThis.location?.origin
    if (!origin) throw new Error('Capture sources need a browser origin.')
    if (!locator.manifestUrl) {
      throw new Error(`Capture session ${locator.sessionId} has no manifest URL.`)
    }
    const manifestUrl = sameOriginUrl(locator.manifestUrl, origin, origin)
    const key = [
      locator.sessionId,
      manifestUrl,
      locator.revisionId ?? '',
      locator.schemaVersion ?? '',
    ].join('|')
    const cached = sources.get(key)
    if (cached) return cached

    const source = createHttpCaptureSource(
      { ...locator, manifestUrl },
      {
        credentials: 'same-origin',
        fetch: options.fetch,
        resolveArtifact: async (artifact: CaptureArtifactReference) => {
          if (!artifact.uri) throw new Error(`Capture artifact ${artifact.id} has no URI.`)
          return { url: sameOriginUrl(artifact.uri, manifestUrl, origin) }
        },
      },
    )
    sources.set(key, source)
    return source
  }
}

const ARTIFACT_PATH = /^\/api\/artifacts\/[0-9a-f]{64}$/

export function sameOriginUrl(value: string, base: string, origin: string): string {
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    throw new Error('Capture URL is not valid.')
  }
  if (url.origin !== new URL(origin).origin) {
    throw new Error('Capture data must be served from this origin.')
  }
  if (!ARTIFACT_PATH.test(url.pathname) || url.search || url.hash) {
    throw new Error('Capture data must come from the artifact store.')
  }
  return url.toString()
}
