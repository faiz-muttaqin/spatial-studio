package com.faizmuttaqin.spatialstudio.security

import com.faizmuttaqin.spatialstudio.security.PermissionPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Test

class PermissionPolicyTest {
    private val allowlist = OriginAllowlist(listOf("https://spatial-studio.faizmuttaqin.com"))
    private val video = listOf(PermissionPolicy.VIDEO_CAPTURE)
    private val audio = "android.webkit.resource.AUDIO_CAPTURE"

    @Test
    fun grantsVideoToTrustedOriginWithCameraPermission() {
        assertEquals(Decision.GRANT_VIDEO, PermissionPolicy.decide(allowlist, "https://spatial-studio.faizmuttaqin.com/", video, true))
        // Audio alongside video: only video is ever granted.
        assertEquals(Decision.GRANT_VIDEO, PermissionPolicy.decide(allowlist, "https://spatial-studio.faizmuttaqin.com/", video + audio, true))
    }

    @Test
    fun asksForCameraPermissionFirst() {
        assertEquals(Decision.DENY_AND_REQUEST_CAMERA, PermissionPolicy.decide(allowlist, "https://spatial-studio.faizmuttaqin.com/", video, false))
    }

    @Test
    fun deniesEverythingElse() {
        assertEquals(Decision.DENY, PermissionPolicy.decide(allowlist, "https://example.com/", video, true))
        assertEquals(Decision.DENY, PermissionPolicy.decide(allowlist, null, video, true))
        assertEquals(Decision.DENY, PermissionPolicy.decide(allowlist, "https://spatial-studio.faizmuttaqin.com/", listOf(audio), true))
        assertEquals(Decision.DENY, PermissionPolicy.decide(allowlist, "https://spatial-studio.faizmuttaqin.com/", listOf("android.webkit.resource.PROTECTED_MEDIA_ID"), true))
    }
}
