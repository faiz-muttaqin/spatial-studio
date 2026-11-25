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
    fun readsBackTheUploadPlan() {
        val store = ScanStore(tmp.newFolder("scans"))
        val dir = store.create(a, null, 1_000)
        val bundle = ScanBundleWriter(dir).finalize(TestBundles.write(dir, a))
        val plan = store.uploadPlan(a)
        assertEquals(bundle.manifest.sha256, plan.manifest.sha256)
        assertEquals(bundle.artifacts.map { it.sha256 }, plan.artifacts.map { it.sha256 })
    }
}
