package com.faizmuttaqin.spatialstudio.security

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
        val parsed = url?.let { split(it) } ?: return false
        return origins.any { it == parsed.origin }
    }

    companion object {
        val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

        private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://")
        private val HOST = Regex("^[a-z0-9._-]+$")
        private val PORT = Regex("^[0-9]{1,5}$")

        private class Parsed(val origin: Origin, val rest: String)

        /** Parses a bare origin. A path other than "/", a query, a fragment or user info is rejected. */
        fun parseOrigin(value: String): Origin? {
            val parsed = split(value.trim()) ?: return null
            return parsed.origin.takeIf { parsed.rest.isEmpty() || parsed.rest == "/" }
        }

        /**
         * Splits a hierarchical http(s) URL into its origin and the rest. Only the
         * authority is interpreted, so anything in the path, query or fragment is
         * accepted as is; anything unusual in the authority fails closed.
         */
        private fun split(url: String): Parsed? {
            val scheme = SCHEME.find(url)?.groupValues?.get(1)?.lowercase() ?: return null
            if (scheme != "https" && scheme != "http") return null
            val afterScheme = url.substring(scheme.length + 3)
            // Browsers end the authority at any of these; a backslash counts like a slash.
            val end = afterScheme.indexOfFirst { it == '/' || it == '?' || it == '#' || it == '\\' }
                .let { if (it == -1) afterScheme.length else it }
            val authority = afterScheme.substring(0, end)
            if (authority.contains('@')) return null
            val colon = authority.lastIndexOf(':')
            val host = (if (colon == -1) authority else authority.substring(0, colon)).lowercase().trimEnd('.')
            val portText = if (colon == -1) null else authority.substring(colon + 1)
            if (host.isEmpty() || !HOST.matches(host)) return null
            val defaultPort = if (scheme == "https") 443 else 80
            val port = when {
                portText == null || portText.isEmpty() -> -1
                PORT.matches(portText) -> portText.toInt().takeIf { it in 1..65535 } ?: return null
                else -> return null
            }
            val normalizedPort = if (port == defaultPort) -1 else port
            return Parsed(Origin(scheme, host, normalizedPort), afterScheme.substring(end))
        }
    }
}
