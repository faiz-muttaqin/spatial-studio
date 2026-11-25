package com.faizmuttaqin.spatialstudio.scan

import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import com.faizmuttaqin.spatialstudio.bridge.BridgeException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanParamsTest {
    private fun params(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private fun invalid(block: () -> Unit) {
        val e = assertThrows(BridgeException::class.java) { block() }
        assertEquals(BridgeErrorCode.INVALID_REQUEST, e.code)
    }

    @Test
    fun defaultsMatchTheContract() {
        val start = ScanParams.start(params("{}"))
        assertNull(start.projectId)
        assertEquals(ScanOptions(depth = true, keyframeSpacingM = 0.25, keyframeAngleDeg = 15.0, maxKeyframes = 300), start.options)
    }

    @Test
    fun readsOptions() {
        val start = ScanParams.start(params("""{"projectId":"p-1","options":{"depth":false,"keyframeSpacingM":0.5,"maxKeyframes":120}}"""))
        assertEquals("p-1", start.projectId)
        assertEquals(ScanOptions(depth = false, keyframeSpacingM = 0.5, maxKeyframes = 120), start.options)
    }

    @Test
    fun locationIsOffByDefaultAndSensorsAreOn() {
        val options = ScanParams.start(params("{}")).options
        assertFalse(options.location)
        assertTrue(options.sensors)
    }

    @Test
    fun readsSensorOptIns() {
        val on = ScanParams.start(params("""{"options":{"location":true,"sensors":false}}""")).options
        assertTrue(on.location)
        assertFalse(on.sensors)
        invalid { ScanParams.start(params("""{"options":{"location":"yes"}}""")) }
        invalid { ScanParams.start(params("""{"options":{"sensors":1}}""")) }
    }

    @Test
    fun rejectsBadOptions() {
        invalid { ScanParams.start(params("""{"options":{"depth":"yes"}}""")) }
        invalid { ScanParams.start(params("""{"options":{"keyframeSpacingM":0.001}}""")) }
        invalid { ScanParams.start(params("""{"options":{"keyframeSpacingM":"0.3"}}""")) }
        invalid { ScanParams.start(params("""{"options":{"maxKeyframes":301}}""")) }
        invalid { ScanParams.start(params("""{"options":{"maxKeyframes":1.5}}""")) }
        invalid { ScanParams.start(params("""{"options":[]}""")) }
        invalid { ScanParams.start(params("""{"projectId":42}""")) }
        invalid { ScanParams.start(params("""{"projectId":""}""")) }
        invalid { ScanParams.start(params("""{"projectId":"a\nb"}""")) }
    }

    @Test
    fun sessionIdsAreUuidsOnly() {
        assertTrue(ScanParams.isSessionId("0f8fad5b-d9cb-469f-a165-70867728950e"))
        assertFalse(ScanParams.isSessionId("../../shared_prefs"))
        assertFalse(ScanParams.isSessionId("0F8FAD5B-D9CB-469F-A165-70867728950E"))
        assertFalse(ScanParams.isSessionId(null))
        invalid { ScanParams.sessionId(params("""{"sessionId":"../x"}""")) }
        invalid { ScanParams.sessionId(params("{}")) }
        assertEquals("0f8fad5b-d9cb-469f-a165-70867728950e", ScanParams.sessionId(params("""{"sessionId":"0f8fad5b-d9cb-469f-a165-70867728950e"}""")))
    }

    @Test
    fun livePreviewIsOffByDefaultAndMustBeABoolean() {
        assertFalse(ScanParams.start(params("{}")).options.livePreview)
        assertTrue(ScanParams.start(params("""{"options":{"livePreview":true}}""")).options.livePreview)
        invalid { ScanParams.start(params("""{"options":{"livePreview":"yes"}}""")) }
        invalid { ScanParams.start(params("""{"options":{"livePreview":1}}""")) }
    }
}
