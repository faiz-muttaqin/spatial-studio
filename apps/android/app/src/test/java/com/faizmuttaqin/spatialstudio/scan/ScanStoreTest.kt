package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ScanStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val a = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private val b = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

    @Test
    fun createsListsAndDiscardsSessions() {
        val store = ScanStore(tmp.newFolder("scans"))
        store.create(a, "p1", 1_000)
        store.create(b, null, 2_000)
        assertEquals(listOf(b, a), store.list().map { it.sessionId })
        assertEquals(SessionRecord.RECORDING, store.read(a)?.state)

        store.write(store.read(a)!!.copy(state = SessionRecord.READY, keyframes = 12, bytes = 3456, uploadedAtMs = 5_000))
        val record = store.read(a)!!
        assertEquals(12, record.keyframes)
        assertTrue(record.uploaded)
        assertEquals("p1", record.projectId)

        assertTrue(store.discard(a))
        assertFalse(store.discard(a))
        assertNull(store.read(a))
        assertEquals(listOf(b), store.list().map { it.sessionId })
    }

    @Test
    fun onlyUuidSessionIdsMapToDirectories() {
        val store = ScanStore(tmp.newFolder("scans"))
        assertThrows(IllegalArgumentException::class.java) { store.dir("../shared_prefs") }
        assertNull(store.read("../../etc"))
        // Stray directories that are not sessions are not listed.
        tmp.newFolder("scans", "not-a-session")
        assertTrue(store.list().isEmpty())
    }

    @Test
    fun keepsTheReasonAFailedScanWasNotSaved() {
        val store = ScanStore(tmp.newFolder("scans"))
        store.create(a, null, 1_000)
        store.write(store.read(a)!!.copy(state = SessionRecord.FAILED, error = "Could not save the scan: ENOSPC"))
        assertEquals("Could not save the scan: ENOSPC", store.read(a)?.error)
        assertEquals(SessionRecord.FAILED, store.list().single().state)
    }

    @Test
    fun sweepsOnlyAbandonedRecordings() {
        val store = ScanStore(tmp.newFolder("scans"))
        val hour = 60L * 60 * 1000
        val now = 100 * hour
        val c = "3b241101-e2bb-4255-8caf-4136c566a962"
        val d = "9b2e3c4d-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
        store.create(a, null, now - 30 * hour) // recording, old: swept
        store.create(b, null, now - 30 * hour)
        store.write(store.read(b)!!.copy(state = SessionRecord.FAILED, error = "x")) // failed: kept
        store.create(c, null, now - 1 * hour) // recording, recent: kept
        store.create(d, null, now - 30 * hour) // the running scan: kept
        val orphan = tmp.newFolder("scans", "6f1c2d3e-4b5a-4c6d-9e8f-7a6b5c4d3e2f").apply { setLastModified(now - 30 * hour) }
        assertEquals(2, store.sweepStale(now, 24 * hour, activeSessionId = d))
        assertFalse(store.dir(a).exists())
        assertFalse(orphan.exists())
        assertEquals(setOf(b, c, d), store.list().map { it.sessionId }.toSet())
    }

    @Test
    fun readsBackTheUploadPlan() {
        val store = ScanStore(tmp.newFolder("scans"))
        val dir = store.create(a, null, 1_000)
        val bundle = ScanBundleWriter(dir).finalize(TestBundles.write(dir, a))
        val plan = store.uploadPlan(a)
        assertEquals(bundle.manifest.sha256, plan.manifest.sha256)
        assertEquals(bundle.artifacts.map { it.sha256 }, plan.artifacts.map { it.sha256 })
    }

    @Test
    fun recordKeepsTheUploadOriginAndAttachedMarker() {
        val store = ScanStore(tmp.newFolder("scans2"))
        store.create(a, null, 1)
        store.update(a) { it.copy(state = SessionRecord.READY, uploadedAtMs = 5, uploadedOrigin = "https://x.example") }
        store.update(a) { it.copy(attachedAtMs = 9) }
        val record = store.read(a)!!
        assertEquals("https://x.example", record.uploadedOrigin)
        assertEquals(9L, record.attachedAtMs)
        assertNull(store.update(b) { it })
    }

    @Test
    fun concurrentWritersNeverLoseTheRecord() {
        val store = ScanStore(tmp.newFolder("scans3"))
        store.create(a, "p", 1)
        val threads = (1..4).map { n ->
            Thread { repeat(100) { i -> store.update(a) { it.copy(keyframes = n * 1000 + i) } } }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        assertEquals("p", store.read(a)?.projectId)
        // No temporary files are left behind.
        assertEquals(listOf("session.json"), store.dir(a).list()!!.toList())
    }
}
