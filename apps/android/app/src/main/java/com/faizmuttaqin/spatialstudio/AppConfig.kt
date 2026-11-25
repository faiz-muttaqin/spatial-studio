package com.faizmuttaqin.spatialstudio

import com.faizmuttaqin.spatialstudio.security.OriginAllowlist

object AppConfig {
    /** Studio origin first (opened on launch), then the debug-only dev origin when set. */
    val allowlist: OriginAllowlist by lazy {
        OriginAllowlist(listOf(BuildConfig.STUDIO_ORIGIN, BuildConfig.DEV_ORIGIN))
    }

    const val BRIDGE_OBJECT_NAME = "SpatialStudioNative"
}
