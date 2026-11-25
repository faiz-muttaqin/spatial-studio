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

    private class Call(val url: String, val headers: Map<String, String>, val bytes: ByteArray, val at: Long)

    /** Fake clock: sleeping advances it. */
    private class Clock {
        var nowMs = 0L
        val sleeps = ArrayList<Long>()
        fun sleep(ms: Long) {
            sleeps += ms
            nowMs += ms
        }
    }

    private class FakeTransport(private val clock: Clock? = null, private val script: (Int, String) -> ArtifactTransport.Response) : ArtifactTransport {
        val calls = ArrayList<Call>()
        override fun put(url: String, headers: Map<String, String>, file: File, length: Long): ArtifactTransport.Response {
            calls += Call(url, headers, file.readBytes(), clock?.nowMs ?: 0)
            return script(calls.size, url)
        }
    }

    private fun bundle(name: String = "bundle"): Pair<File, FinalizedBundle> {
        val dir = tmp.newFolder(name)
        return dir to ScanBundleWriter(dir).finalize(TestBundles.write(dir))
    }

    private fun uploader(transport: ArtifactTransport, clock: Clock = Clock(), minIntervalMs: Long = 0, maxAttempts: Int = 8) =
        ArtifactUploader(transport, { cookie }, sleep = clock::sleep, now = { clock.nowMs }, maxAttempts = maxAttempts, minIntervalMs = minIntervalMs)

    @Test
    fun uploadsEveryArtifactThenTheManifestToTheTrustedOrigin() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        val progress = ArrayList<Int>()
        val result = uploader(transport).upload(origin, dir, bundle) { progress += it.uploaded }

        val expected = bundle.artifacts.map { it.sha256 } + bundle.manifest.sha256
        assertEquals(expected.map { "https://spatial-studio.faizmuttaqin.com/api/artifacts/$it" }, transport.calls.map { it.url })
        assertEquals("/api/artifacts/${bundle.manifest.sha256}", result.manifestUrl)
        assertEquals(bundle.manifest.sha256, result.manifestSha256)
        assertEquals((0..expected.size).toList(), progress.distinct())
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
        ArtifactUploader(transport, { null }, sleep = {}, minIntervalMs = 0).upload(origin, dir, bundle)
        transport.calls.forEach { assertNull(it.headers["Cookie"]) }
    }

    @Test
    fun pacesRequestsBelowTheServerRateLimit() {
        val (dir, bundle) = bundle()
        val clock = Clock()
        val transport = FakeTransport(clock) { _, _ -> ArtifactTransport.Response(200) }
        uploader(transport, clock, minIntervalMs = ArtifactUploader.DEFAULT_MIN_INTERVAL_MS).upload(origin, dir, bundle)
        val gaps = transport.calls.zipWithNext { a, b -> b.at - a.at }
        assertTrue(gaps.all { it >= ArtifactUploader.DEFAULT_MIN_INTERVAL_MS })
        // At most 90 requests in any minute.
        assertTrue(60_000 / ArtifactUploader.DEFAULT_MIN_INTERVAL_MS <= 90)
    }

    @Test
    fun honoursRetryAfterOnRateLimit() {
        val (dir, bundle) = bundle()
        val clock = Clock()
        val transport = FakeTransport(clock) { n, _ -> if (n == 1) ArtifactTransport.Response(429, 3) else ArtifactTransport.Response(200) }
        uploader(transport, clock).upload(origin, dir, bundle)
        assertEquals(listOf(3_000L), clock.sleeps)
        assertEquals(bundle.artifacts.size + 2, transport.calls.size)
        assertEquals(transport.calls[0].url, transport.calls[1].url)
    }

    @Test
    fun retriesServerAndNetworkErrorsWithBackoff() {
        val (dir, bundle) = bundle()
        val clock = Clock()
        var n = 0
        val transport = ArtifactTransport { _, _, _, _ ->
            n++
            when (n) {
                1 -> throw IOException("reset")
                2 -> ArtifactTransport.Response(502)
                else -> ArtifactTransport.Response(200)
            }
        }
        uploader(transport, clock).upload(origin, dir, bundle)
        assertEquals(listOf(1_000L, 2_000L), clock.sleeps)
    }

    @Test
    fun resumesFromTheUploadLogAndAlwaysSendsTheManifest() {
        val (dir, bundle) = bundle()
        val log = UploadLog(File(dir, UploadLog.FILE))
        // First attempt: the fourth request fails for good.
        val failing = FakeTransport { n, _ -> if (n >= 4) ArtifactTransport.Response(401) else ArtifactTransport.Response(200) }
        assertThrows(UploadFailedException::class.java) { uploader(failing).upload(origin, dir, bundle, log) }
        assertEquals(3, log.stored(origin.toString()).size)

        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        val result = uploader(transport).upload(origin, dir, bundle, log)
        assertEquals(3, result.skipped)
        assertEquals(bundle.artifacts.size - 3 + 1, result.sent)
        assertFalse(transport.calls.any { call -> failing.calls.take(3).any { it.url == call.url } })
        assertTrue(transport.calls.last().url.endsWith(bundle.manifest.sha256))

        // A second full run sends only the manifest.
        val again = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        assertEquals(1, uploader(again).upload(origin, dir, bundle, log).sent)
        assertEquals(1, again.calls.size)
    }

    @Test
    fun theLogIsPerOrigin() {
        val (dir, bundle) = bundle()
        val log = UploadLog(File(dir, UploadLog.FILE))
        uploader(FakeTransport { _, _ -> ArtifactTransport.Response(200) }).upload(origin, dir, bundle, log)
        val dev = OriginAllowlist(listOf("http://localhost:3002")).home
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        uploader(transport).upload(dev, dir, bundle, log)
        assertEquals(bundle.artifacts.size + 1, transport.calls.size)
    }

    @Test
    fun sendsIdenticalContentOnce() {
        val (dir, bundle) = bundle()
        val duplicated = FinalizedBundle(bundle.manifest, bundle.artifacts + bundle.artifacts.first())
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        uploader(transport).upload(origin, dir, duplicated)
        assertEquals(transport.calls.size, transport.calls.map { it.url }.toSet().size)
        assertEquals(bundle.artifacts.size + 1, transport.calls.size)
    }

    @Test
    fun failsFastOnAuthErrorsWithoutLeakingTheCookie() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(401) }
        val e = assertThrows(UploadFailedException::class.java) { uploader(transport).upload(origin, dir, bundle) }
        assertEquals(1, transport.calls.size)
        assertTrue(e.message!!.contains("Not signed in"))
        assertFalse(e.message!!.contains("secret-value"))
    }

    @Test
    fun givesUpAfterMaxAttempts() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(503) }
        assertThrows(UploadFailedException::class.java) { uploader(transport, maxAttempts = 3).upload(origin, dir, bundle) }
        assertEquals(3, transport.calls.size)
    }

    @Test
    fun refusesFilesThatChangedAfterFinalizing() {
        val (dir, bundle) = bundle()
        File(dir, "keyframes/kf-0001.jpg").writeBytes(byteArrayOf(9, 9, 9))
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        assertThrows(UploadFailedException::class.java) { uploader(transport).upload(origin, dir, bundle) }
        assertFalse(transport.calls.any { it.url.endsWith(bundle.manifest.sha256) })
    }

    @Test
    fun uploadLogIgnoresMalformedLines() {
        val file = tmp.newFile("log.txt")
        val sha = "a".repeat(64)
        file.writeText("https://spatial-studio.faizmuttaqin.com $sha\ngarbage\nhttps://spatial-studio.faizmuttaqin.com nothex\n")
        assertEquals(setOf(sha), UploadLog(file).stored("https://spatial-studio.faizmuttaqin.com"))
    }

    @Test
    fun retryDelaysAreBounded() {
        assertEquals(30_000L, ArtifactUploader.retryDelayMs(429, 3600, 1))
        assertEquals(1_000L, ArtifactUploader.retryDelayMs(429, 0, 1))
        assertEquals(30_000L, ArtifactUploader.retryDelayMs(500, null, 10))
    }

    @Test
    fun capsTotalRetriesAndLogsEachRetryWithoutUrlsOrCookies() {
        val (dir, bundle) = bundle()
        val clock = Clock()
        val lines = ArrayList<String>()
        val transport = FakeTransport(clock) { _, _ -> ArtifactTransport.Response(503) }
        val u = ArtifactUploader(transport, { cookie }, sleep = clock::sleep, now = { clock.nowMs }, maxAttempts = 100, minIntervalMs = 0, maxTotalRetries = 3, log = { lines += it })
        assertThrows(UploadFailedException::class.java) { u.upload(origin, dir, bundle) }
        assertEquals(4, transport.calls.size)
        assertEquals(4, lines.size)
        assertTrue(lines.all { "status=503" in it && "wait=" in it && "http" !in it && "secret" !in it })
    }

    @Test
    fun capsTheTimeOneArtifactMayTake() {
        val (dir, bundle) = bundle()
        val clock = Clock()
        val transport = FakeTransport(clock) { _, _ -> ArtifactTransport.Response(500) }
        val u = ArtifactUploader(transport, { cookie }, sleep = clock::sleep, now = { clock.nowMs }, maxAttempts = 100, minIntervalMs = 0, maxArtifactMs = 10_000)
        assertThrows(UploadFailedException::class.java) { u.upload(origin, dir, bundle) }
        // Waits are 1, 2, 4 s: the 8 s wait would end past 10 s, so the fourth failure is final.
        assertTrue(clock.nowMs <= 10_000)
        assertEquals(4, transport.calls.size)
    }

    @Test
    fun capsTheWholeUpload() {
        val (dir, bundle) = bundle()
        val clock = Clock()
        val transport = FakeTransport(clock) { _, _ -> clock.nowMs += 5_000; ArtifactTransport.Response(200) }
        val u = ArtifactUploader(transport, { cookie }, sleep = clock::sleep, now = { clock.nowMs }, minIntervalMs = 0, maxTotalMs = 7_000)
        assertThrows(UploadFailedException::class.java) { u.upload(origin, dir, bundle) }
        assertEquals(2, transport.calls.size)
    }

    @Test
    fun reportsThePhaseAndSendsTheManifestLastInItsOwnPhase() {
        val (dir, bundle) = bundle()
        val phases = ArrayList<String>()
        uploader(FakeTransport { _, _ -> ArtifactTransport.Response(200) }).upload(origin, dir, bundle) { phases += it.phase }
        assertEquals("artifacts", phases.first())
        assertEquals("manifest", phases.last())
        assertTrue(phases.count { it == "manifest" } >= 2)
    }

    @Test
    fun aCancelledUploadStopsBetweenArtifacts() {
        val (dir, bundle) = bundle()
        val transport = FakeTransport { _, _ -> ArtifactTransport.Response(200) }
        var cancelled = false
        val ex = assertThrows(UploadFailedException::class.java) {
            uploader(transport).upload(origin, dir, bundle, isCancelled = { cancelled }) { if (it.uploaded == 1) cancelled = true }
        }
        assertEquals(1, transport.calls.size)
        assertTrue(ex.message!!.contains("replaced"))
    }

    @Test
    fun retriesCountAsActivity() {
        val (dir, bundle) = bundle()
        var activity = 0
        val transport = FakeTransport { n, _ -> if (n <= 2) ArtifactTransport.Response(500) else ArtifactTransport.Response(200) }
        uploader(transport, Clock()).upload(origin, dir, bundle) { activity++ }
        val withoutRetries = run {
            var count = 0
            val (d2, b2) = bundle("b2")
            uploader(FakeTransport { _, _ -> ArtifactTransport.Response(200) }).upload(origin, d2, b2) { count++ }
            count
        }
        assertEquals(withoutRetries + 2, activity)
    }

    @Test
    fun runsDoNotShareCountersOrClocks() {
        val (dir, bundle) = bundle()
        val clock = Clock()
        val transport = FakeTransport(clock) { _, _ -> ArtifactTransport.Response(503) }
        val u = ArtifactUploader(transport, { cookie }, sleep = clock::sleep, now = { clock.nowMs }, maxAttempts = 100, minIntervalMs = 0, maxTotalRetries = 2)
        assertThrows(UploadFailedException::class.java) { u.upload(origin, dir, bundle) }
        val before = transport.calls.size
        // A second run on the same uploader starts with a fresh retry budget: again 3 attempts, not 1.
        assertThrows(UploadFailedException::class.java) { u.upload(origin, dir, bundle) }
        assertEquals(before * 2, transport.calls.size)
    }

    @Test
    fun passesTheControlToTheTransportAndCountsActivity() {
        val (dir, bundle) = bundle()
        var activity = 0
        val transport = object : ArtifactTransport {
            override fun put(url: String, headers: Map<String, String>, file: File, length: Long) = error("control variant expected")
            override fun put(url: String, headers: Map<String, String>, file: File, length: Long, control: PutControl): ArtifactTransport.Response {
                control.onActivity()
                return ArtifactTransport.Response(200)
            }
        }
        uploader(transport).upload(origin, dir, bundle, onActivity = { activity++ })
        assertTrue(activity >= bundle.artifacts.size)
    }
}
