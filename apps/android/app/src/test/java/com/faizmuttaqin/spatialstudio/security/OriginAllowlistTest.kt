package com.faizmuttaqin.spatialstudio.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginAllowlistTest {
    private val studio = "https://spatial-studio.faizmuttaqin.com"
    private val release = OriginAllowlist(listOf(studio, ""))
    private val debug = OriginAllowlist(listOf(studio, "http://localhost:3002"))

    @Test
    fun releaseTrustsOnlyTheStudioOrigin() {
        assertEquals(setOf(studio), release.webMessageRules)
        assertEquals(studio, release.home.toString())
    }

    @Test
    fun debugAddsTheDevOriginToTheSameList() {
        assertEquals(setOf(studio, "http://localhost:3002"), debug.webMessageRules)
        assertTrue(debug.isAllowedOrigin("http://localhost:3002"))
        assertFalse(release.isAllowedOrigin("http://localhost:3002"))
    }

    @Test
    fun originMatchingIsExact() {
        assertTrue(release.isAllowedOrigin(studio))
        assertTrue(release.isAllowedOrigin("$studio/"))
        assertTrue(release.isAllowedOrigin("HTTPS://Spatial-Studio.FaizMuttaqin.com"))
        assertTrue(release.isAllowedOrigin("$studio:443"))
        assertFalse(release.isAllowedOrigin("http://spatial-studio.faizmuttaqin.com"))
        assertFalse(release.isAllowedOrigin("$studio:8443"))
        assertFalse(release.isAllowedOrigin("https://evil.spatial-studio.faizmuttaqin.com"))
        assertFalse(release.isAllowedOrigin("https://spatial-studio.faizmuttaqin.com.evil.example"))
        assertFalse(release.isAllowedOrigin("null"))
        assertFalse(release.isAllowedOrigin(""))
        assertFalse(release.isAllowedOrigin(null))
        assertFalse(debug.isAllowedOrigin("http://localhost:3000"))
    }

    @Test
    fun navigationAllowsPathsOnTrustedOriginsOnly() {
        assertTrue(release.isAllowedNavigation("$studio/"))
        assertTrue(release.isAllowedNavigation("$studio/project/abc?view=3d#top"))
        assertTrue(debug.isAllowedNavigation("http://localhost:3002/scan"))
        assertFalse(release.isAllowedNavigation("http://spatial-studio.faizmuttaqin.com/"))
        assertFalse(release.isAllowedNavigation("https://example.com/"))
        assertFalse(release.isAllowedNavigation("https://spatial-studio.faizmuttaqin.com@evil.example/"))
        assertFalse(release.isAllowedNavigation("https://user:pass@spatial-studio.faizmuttaqin.com/"))
        assertFalse(release.isAllowedNavigation("javascript:alert(1)"))
        assertFalse(release.isAllowedNavigation("intent://scan#Intent;scheme=https;end"))
        assertFalse(release.isAllowedNavigation("file:///data/data/x"))
        assertFalse(release.isAllowedNavigation("blob:$studio/1234"))
        assertFalse(release.isAllowedNavigation("not a url"))
        assertFalse(release.isAllowedNavigation(null))
    }

    @Test
    fun matchReturnsTheConfiguredOrigin() {
        assertEquals(studio, release.match("$studio/")?.toString())
        assertNull(release.match("https://example.com"))
    }

    @Test
    fun rejectsUnsafeConfiguration() {
        assertThrows(IllegalArgumentException::class.java) { OriginAllowlist(listOf("http://spatial-studio.faizmuttaqin.com")) }
        assertThrows(IllegalArgumentException::class.java) { OriginAllowlist(listOf("https://*.example.com")) }
        assertThrows(IllegalArgumentException::class.java) { OriginAllowlist(listOf("https://example.com/path")) }
        assertThrows(IllegalArgumentException::class.java) { OriginAllowlist(listOf("")) }
        assertThrows(IllegalArgumentException::class.java) { OriginAllowlist(listOf("http://192.168.1.10:3002")) }
    }
}
