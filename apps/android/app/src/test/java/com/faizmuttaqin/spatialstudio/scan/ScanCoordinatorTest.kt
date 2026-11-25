package com.faizmuttaqin.spatialstudio.scan

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanCoordinatorTest {
    private val a = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private val b = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

    @After
    fun reset() {
        ScanCoordinator.end(a)
        ScanCoordinator.end(b)
        ScanCoordinator.endUpload(a)
        ScanCoordinator.endUpload(b)
    }

    @Test
    fun oneScanAtATime() {
        assertTrue(ScanCoordinator.begin(ScanCoordinator.ActiveScan(a, null, ScanOptions())))
        assertFalse(ScanCoordinator.begin(ScanCoordinator.ActiveScan(b, null, ScanOptions())))
        ScanCoordinator.end(b) // not the running scan: no effect
        assertEquals(a, ScanCoordinator.active?.sessionId)
        ScanCoordinator.end(a)
        assertNull(ScanCoordinator.active)
    }

    @Test
    fun watchdogReleasesAScanWhoseScreenNeverOpened() {
        ScanCoordinator.begin(ScanCoordinator.ActiveScan(a, null, ScanOptions()))
        assertTrue(ScanCoordinator.expireIfNotStarted(a))
        assertNull(ScanCoordinator.active)
        // A late screen for the expired scan cannot claim it.
        assertFalse(ScanCoordinator.markStarted(a))
        assertTrue(ScanCoordinator.begin(ScanCoordinator.ActiveScan(b, null, ScanOptions())))
    }

    @Test
    fun watchdogLeavesAStartedScanAlone() {
        ScanCoordinator.begin(ScanCoordinator.ActiveScan(a, null, ScanOptions()))
        assertTrue(ScanCoordinator.markStarted(a))
        assertFalse(ScanCoordinator.expireIfNotStarted(a))
        assertEquals(a, ScanCoordinator.active?.sessionId)
    }

    @Test
    fun oneUploadAtATimeAcrossBridges() {
        assertTrue(ScanCoordinator.beginUpload(a))
        assertFalse(ScanCoordinator.beginUpload(b))
        assertFalse(ScanCoordinator.beginUpload(a))
        ScanCoordinator.endUpload(b)
        assertEquals(a, ScanCoordinator.uploading)
        ScanCoordinator.endUpload(a)
        assertTrue(ScanCoordinator.beginUpload(b))
    }
}

class UploadJoinTest {
    private val a = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private val b = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    private val ok = ScanCoordinator.UploadOutcome.Ok(
        kotlinx.serialization.json.JsonObject(mapOf("sessionId" to kotlinx.serialization.json.JsonPrimitive(a))),
    )

    @org.junit.After fun reset() {
        ScanCoordinator.endUpload(a)
        ScanCoordinator.endUpload(b)
    }

    @Test fun `a second request for the same session joins and gets the same result`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        assertEquals(ScanCoordinator.UploadJoin.STARTED, ScanCoordinator.beginOrJoinUpload(a) { got.add(it) })
        assertEquals(ScanCoordinator.UploadJoin.JOINED, ScanCoordinator.beginOrJoinUpload(a) { got.add(it) })
        assertTrue(got.isEmpty())
        ScanCoordinator.finishUpload(a, ok)
        assertEquals(2, got.size)
        assertTrue(got.all { it === ok })
        assertNull(ScanCoordinator.uploading)
    }

    @Test fun `a different session is busy and is not queued`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        ScanCoordinator.beginOrJoinUpload(a) { got.add(it) }
        assertEquals(ScanCoordinator.UploadJoin.BUSY, ScanCoordinator.beginOrJoinUpload(b) { got.add(it) })
        ScanCoordinator.finishUpload(a, ok)
        assertEquals(1, got.size)
    }

    @Test fun `failures reach every waiter and free the slot`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        ScanCoordinator.beginOrJoinUpload(a) { got.add(it) }
        ScanCoordinator.beginOrJoinUpload(a) { got.add(it) }
        val failed = ScanCoordinator.UploadOutcome.Failed(com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode.UPLOAD_FAILED, "x")
        ScanCoordinator.finishUpload(a, failed)
        assertEquals(listOf<Any>(failed, failed), got)
        assertEquals(ScanCoordinator.UploadJoin.STARTED, ScanCoordinator.beginOrJoinUpload(a) { })
    }

    @Test fun `success is emitted as upload done to listeners`() {
        val events = ArrayList<String>()
        val listener = ScanCoordinator.Listener { event, _ -> events.add(event) }
        ScanCoordinator.addListener(listener)
        try {
            ScanCoordinator.beginOrJoinUpload(a) { }
            ScanCoordinator.finishUpload(a, ok)
        } finally {
            ScanCoordinator.removeListener(listener)
        }
        assertEquals(listOf("upload.done"), events)
    }

    @Test fun `finishing a session that is not uploading does nothing`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        ScanCoordinator.beginOrJoinUpload(a) { got.add(it) }
        ScanCoordinator.finishUpload(b, ok)
        assertTrue(got.isEmpty())
        assertEquals(a, ScanCoordinator.uploading)
    }

    @Test fun `a scan with a stored manifest is answered without network work`() {
        val sha = "a".repeat(64)
        val record = SessionRecord(a, 1L, null, SessionRecord.READY, manifestSha256 = sha, uploadedAtMs = 5L)
        val result = com.faizmuttaqin.spatialstudio.upload.UploadResults.alreadyUploaded(record)!!
        assertEquals("/api/artifacts/$sha", (result["manifestUrl"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals(sha, (result["manifestSha256"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertNull(com.faizmuttaqin.spatialstudio.upload.UploadResults.alreadyUploaded(record.copy(uploadedAtMs = null)))
        assertNull(com.faizmuttaqin.spatialstudio.upload.UploadResults.alreadyUploaded(record.copy(manifestSha256 = null)))
    }
}
