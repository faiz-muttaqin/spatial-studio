package com.faizmuttaqin.spatialstudio.security

/**
 * What to do with a WebView media permission request. Only video capture is
 * ever granted, only to a trusted origin, and only when the app already holds
 * the Android CAMERA permission.
 */
object PermissionPolicy {
    const val VIDEO_CAPTURE = "android.webkit.resource.VIDEO_CAPTURE"

    enum class Decision { GRANT_VIDEO, DENY, DENY_AND_REQUEST_CAMERA }

    fun decide(allowlist: OriginAllowlist, origin: String?, resources: Collection<String>, hasCameraPermission: Boolean): Decision {
        if (!allowlist.isAllowedOrigin(origin)) return Decision.DENY
        if (VIDEO_CAPTURE !in resources) return Decision.DENY
        return if (hasCameraPermission) Decision.GRANT_VIDEO else Decision.DENY_AND_REQUEST_CAMERA
    }
}
