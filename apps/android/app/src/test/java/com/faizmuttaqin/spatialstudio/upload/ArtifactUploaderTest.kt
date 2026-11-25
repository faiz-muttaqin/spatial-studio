package com.faizmuttaqin.spatialstudio.upload

import com.faizmuttaqin.spatialstudio.scan.FinalizedBundle
import com.faizmuttaqin.spatialstudio.scan.ScanBundleWriter
import com.faizmuttaqin.spatialstudio.scan.TestBundles
import com.faizmuttaqin.spatialstudio.security.OriginAllowlist
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class ArtifactUploaderTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val origin = OriginAllowlist(listOf("https://spatial-studio.faizmuttaqin.com")).home
    private val cookie = "session=secret-value"

    private class Call(val url: String, val headers: Map<String, String>, val bytes: ByteArray)

    private class FakeTransport(private val script: (Int, String) -> ArtifactTransport.Response) : ArtifactTransport {
        val calls = ArrayList<Call>()
        override fun put(url: String, headers: Map<String, String>, file: File, length: Long): ArtifactTransport.Response {
            calls += Call(url, headers, file.readBytes())
            return script(calls.size, url)
        }
    }

    private fun bundle(): Pair<File, FinalizedBundle> {
        val dir = tmp.newFolder("bundle")
        return dir to ScanBundleWriter(dir).finalize(TestBundles.write(dir))
    }

    @Test
    fun uploadsEveryArtifactThenTheManifestToTheTrustedOrigin() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        val progress = ArrayList<Int>()
        val result = ArtifactUploader(transport, { cookie }, sleep = {}).upload(origin, dir, bundle) { progress += it.uploaded }

        val expected = bundle.artifacts.map { it.sha256 } + bundle.manifest.sha256
        assertEquals(expected.map { "https://spatial-studio.faizmuttaqin.com/api/artifacts/$it" }, transport.calls.map { it.url })
        assertEquals("/api/artifacts/${bundle.manifest.sha256}", result.manifestUrl)
        assertEquals(bundle.manifest.sha256, result.manifestSha256)
        assertEquals((0..expected.size).toList(), progress)
        for (call in transport.calls) {
            assertEquals("https://spatial-studio.faizmuttaqin.com", call.headers["Origin"])
            assertEquals(cookie, call.headers["Cookie"])
        }
        assertEquals("application/json", transport.calls.last().headers["Content-Type"])
        assertTrue(transport.calls.any { it.headers["Content-Type"] == "image/jpeg" })
        assertEquals(File(dir, "manifest.json").readBytes().toList(), transport.calls.last().bytes.toList())
    }

    @Test
    fun sendsNoCookieHeaderWhenThereIsNoCookie() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        ArtifactUploader(transport, { null }, sleep = {}).upload(origin, dir, bundle)
        transport.calls.forEach { assertNull(it.headers["Cookie"]) }
    }

    @Test
    fun honoursRetryAfterOnRateLimit() {
        val (dir, bundle) = bundle()
        val sleeps = ArrayList<Long>()
        val transport = FakeTransport { n, _ -> if (n == 1) ArtifactTransport.Response(429, 3) else ArtifactTransport.Response(200) }
        ArtifactUploader(transport, { cookie }, sleep = { sleeps += it }).upload(origin, dir, bundle)
        assertEquals(listOf(3_000L), sleeps)
        assertEquals(bundle.artifacts.size + 2, transport.calls.size)
        assertEquals(transport.calls[0].url, transport.calls[1].url)
    }

    @Test
    fun retriesServerAndNetworkErrorsWithBackoff() {
        val (dir, bundle) = bundle()
        val sleeps = ArrayList<Long>()
        var n = 0
        val transport = ArtifactTransport { _, _, _, _ ->
            n++
            when (n) {
                1 -> throw IOException("reset")
                2 -> ArtifactTransport.Response(502)
                else -> ArtifactTransport.Response(200)
            }
        }
        ArtifactUploader(transport, { cookie }, sleep = { sleeps += it }).upload(origin, dir, bundle)
        assertEquals(listOf(1_000L, 2_000L), sleeps)
    }

    @Test
    fun failsFastOnAuthErrorsWithoutLeakingTheCookie() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(401) }
        val e = assertThrows(UploadFailedException::class.java) {
            ArtifactUploader(transport, { cookie }, sleep = {}).upload(origin, dir, bundle)
        }
        assertEquals(1, transport.calls.size)
        assertTrue(e.message!!.contains("Not signed in"))
        assertFalse(e.message!!.contains("secret-value"))
    }

    @Test
    fun givesUpAfterMaxAttempts() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(503) }
        assertThrows(UploadFailedException::class.java) {
            ArtifactUploader(transport, { cookie }, sleep = {}, maxAttempts = 3).upload(origin, dir, bundle)
        }
        assertEquals(3, transport.calls.size)
    }

    @Test
    fun refusesFilesThatChangedAfterFinalizing() {
        val (dir, bundle) = bundle()
        File(dir, "keyframes/kf-0001.jpg").writeBytes(byteArrayOf(9, 9, 9))
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        assertThrows(UploadFailedException::class.java) {
            ArtifactUploader(transport, { cookie }, sleep = {}).upload(origin, dir, bundle)
        }
        assertFalse(transport.calls.any { it.url.endsWith(bundle.manifest.sha256) })
    }

    @Test
    fun retryDelaysAreBounded() {
        assertEquals(60_000L, ArtifactUploader.retryDelayMs(429, 3600, 1))
        assertEquals(1_000L, ArtifactUploader.retryDelayMs(429, 0, 1))
        assertEquals(30_000L, ArtifactUploader.retryDelayMs(500, null, 10))
    }
}
