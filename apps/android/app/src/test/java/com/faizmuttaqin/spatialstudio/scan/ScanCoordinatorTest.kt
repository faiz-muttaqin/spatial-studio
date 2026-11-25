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
        val first = ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = 0)
        assertEquals(ScanCoordinator.UploadJoin.STARTED, first.join)
        assertEquals(ScanCoordinator.UploadJoin.JOINED, ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = 1000).join)
        assertTrue(got.isEmpty())
        ScanCoordinator.finishUpload(a, first.token!!, ok)
        assertEquals(2, got.size)
        assertTrue(got.all { it === ok })
        assertNull(ScanCoordinator.uploading)
    }

    @Test fun `a different session is busy and is not queued`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        val first = ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = 0)
        assertEquals(ScanCoordinator.UploadJoin.BUSY, ScanCoordinator.beginOrJoinUpload(b, { got.add(it) }, nowMs = 10 * 60_000L).join)
        ScanCoordinator.finishUpload(a, first.token!!, ok)
        assertEquals(1, got.size)
    }

    @Test fun `failures reach every waiter and free the slot`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        val first = ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = 0)
        ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = 1)
        val failed = ScanCoordinator.UploadOutcome.Failed(com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode.UPLOAD_FAILED, "x")
        ScanCoordinator.finishUpload(a, first.token!!, failed)
        assertEquals(listOf<Any>(failed, failed), got)
        assertEquals(ScanCoordinator.UploadJoin.STARTED, ScanCoordinator.beginOrJoinUpload(a, { }, nowMs = 2).join)
    }

    @Test fun `success is emitted as upload done to listeners`() {
        val events = ArrayList<String>()
        val listener = ScanCoordinator.Listener { event, _ -> events.add(event) }
        ScanCoordinator.addListener(listener)
        try {
            val first = ScanCoordinator.beginOrJoinUpload(a, { }, nowMs = 0)
            ScanCoordinator.finishUpload(a, first.token!!, ok)
        } finally {
            ScanCoordinator.removeListener(listener)
        }
        assertEquals(listOf("upload.done"), events)
    }

    @Test fun `finishing with the wrong session or token does nothing`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        val first = ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = 0)
        ScanCoordinator.finishUpload(b, first.token!!, ok)
        ScanCoordinator.finishUpload(a, ScanCoordinator.UploadToken(), ok)
        assertTrue(got.isEmpty())
        assertEquals(a, ScanCoordinator.uploading)
    }

    @Test fun `an upload with no activity for a minute is replaced and the old run is cancelled`() {
        val got = ArrayList<ScanCoordinator.UploadOutcome>()
        val first = ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = 0)
        val second = ScanCoordinator.beginOrJoinUpload(a, { got.add(it) }, nowMs = ScanCoordinator.UPLOAD_STALE_MS)
        assertEquals(ScanCoordinator.UploadJoin.REPLACED, second.join)
        assertTrue(first.token!!.cancelled.get())
        assertFalse(second.token!!.cancelled.get())
        // The stalled run finally returns: it must not answer or free the replacement.
        ScanCoordinator.finishUpload(a, first.token!!, ScanCoordinator.UploadOutcome.Failed(com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode.UPLOAD_FAILED, "replaced"))
        assertTrue(got.isEmpty())
        assertEquals(a, ScanCoordinator.uploading)
        // Both pages get the replacement's result.
        ScanCoordinator.finishUpload(a, second.token!!, ok)
        assertEquals(2, got.size)
    }

    @Test fun `activity keeps an upload from counting as stalled`() {
        val first = ScanCoordinator.beginOrJoinUpload(a, { }, nowMs = 0)
        ScanCoordinator.touchUpload(first.token!!, nowMs = 50_000)
        assertEquals(ScanCoordinator.UploadJoin.JOINED, ScanCoordinator.beginOrJoinUpload(a, { }, nowMs = 100_000).join)
        assertEquals(ScanCoordinator.UploadJoin.REPLACED, ScanCoordinator.beginOrJoinUpload(a, { }, nowMs = 111_000).join)
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
