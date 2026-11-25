package com.faizmuttaqin.spatialstudio.live

import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveProtocolTest {
    private fun err(raw: String?) = LiveProtocol.parse(raw) as LiveProtocol.Parsed.Error

    @Test
    fun parsesOpenAndClose() {
        val open = LiveProtocol.parse("""{"v":1,"id":"a1","method":"live.open","params":{"transport":"port"}}""") as LiveProtocol.Parsed.Open
        assertEquals("a1", open.id)
        assertEquals("port", open.transport)
        assertEquals("ws", (LiveProtocol.parse("""{"v":1,"id":"a2","method":"live.open","params":{"transport":"ws"}}""") as LiveProtocol.Parsed.Open).transport)
        assertTrue(LiveProtocol.parse("""{"v":1,"id":"a3","method":"live.close"}""") is LiveProtocol.Parsed.Close)
    }

    @Test
    fun refusesEverythingElse() {
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err(null).code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err("[]").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err("{").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err("x".repeat(LiveProtocol.MAX_MESSAGE_BYTES + 1)).code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err("""{"v":2,"id":"a","method":"live.close"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err("""{"v":1,"id":"bad id","method":"live.close"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err("""{"v":1,"id":"a","method":"live.open","params":{"transport":"tcp"}}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, err("""{"v":1,"id":"a","method":"live.open"}""").code)
        // The scan bridge's methods are not reachable from the preview page.
        assertEquals(BridgeErrorCode.UNKNOWN_METHOD, err("""{"v":1,"id":"a","method":"scan.start"}""").code)
        assertEquals(BridgeErrorCode.UNKNOWN_METHOD, err("""{"v":1,"id":"a","method":"scan.upload"}""").code)
    }

    @Test
    fun repliesCarryTheEnvelope() {
        assertTrue(LiveProtocol.ok("a").contains(""""ok":true"""))
        assertTrue(LiveProtocol.error("a", BridgeErrorCode.UNSUPPORTED, "no").contains(""""code":"unsupported""""))
        assertTrue(LiveProtocol.event("closed").contains(""""state":"closed""""))
    }
}
