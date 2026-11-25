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
