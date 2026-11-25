package com.faizmuttaqin.spatialstudio.security

import java.net.URI

/**
 * The single list of origins the app trusts. Navigation, the native bridge,
 * camera grants and uploads all ask this object, so they cannot drift apart.
 */
class OriginAllowlist(origins: List<String>) {

    /** A parsed `scheme://host[:port]` with default ports removed. */
    data class Origin(val scheme: String, val host: String, val port: Int) {
        override fun toString(): String = if (port == -1) "$scheme://$host" else "$scheme://$host:$port"
    }

    val origins: List<Origin> = origins.filter { it.isNotBlank() }.map { raw ->
        requireNotNull(parseOrigin(raw)) { "Not a bare origin: $raw" }.also { origin ->
            require(origin.scheme == "https" || (origin.scheme == "http" && origin.host in LOOPBACK_HOSTS)) {
                "Only https origins, or http on a loopback host, may be trusted: $raw"
            }
        }
    }.distinct()

    init {
        require(this.origins.isNotEmpty()) { "At least one origin is required" }
    }

    /** The first origin is the one the app opens on launch. */
    val home: Origin get() = origins.first()

    /** Origin rules in the form `WebViewCompat.addWebMessageListener` expects. */
    val webMessageRules: Set<String> get() = origins.mapTo(LinkedHashSet()) { it.toString() }

    /** Returns the trusted origin equal to [origin], or null. */
    fun match(origin: String?): Origin? {
        if (origin == null) return null
        val parsed = parseOrigin(origin) ?: return null
        return origins.firstOrNull { it == parsed }
    }

    fun isAllowedOrigin(origin: String?): Boolean = match(origin) != null

    /** True when [url] may be loaded as the top-level document. */
    fun isAllowedNavigation(url: String?): Boolean {
        if (url == null) return false
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        if (uri.isOpaque || uri.rawUserInfo != null) return false
        val parsed = originOf(uri) ?: return false
        return origins.any { it == parsed }
    }

    companion object {
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

        /** Parses a bare origin. Paths other than "/" , queries, fragments and user info are rejected. */
        fun parseOrigin(value: String): Origin? {
            val uri = runCatching { URI(value.trim()) }.getOrNull() ?: return null
            if (uri.isOpaque || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            val path = uri.rawPath
            if (!path.isNullOrEmpty() && path != "/") return null
            return originOf(uri)
        }

        private fun originOf(uri: URI): Origin? {
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "https" && scheme != "http") return null
            val host = uri.host?.lowercase()?.trimEnd('.') ?: return null
            if (host.isEmpty() || host.contains('*')) return null
            val defaultPort = if (scheme == "https") 443 else 80
            val port = if (uri.port == defaultPort) -1 else uri.port
            return Origin(scheme, host, port)
        }
    }
}
