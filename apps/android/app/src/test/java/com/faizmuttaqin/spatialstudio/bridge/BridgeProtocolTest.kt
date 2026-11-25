package com.faizmuttaqin.spatialstudio.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {

    private fun error(raw: String?): BridgeProtocol.Parsed.Error =
        BridgeProtocol.parse(raw) as BridgeProtocol.Parsed.Error

    @Test
    fun parsesAValidRequest() {
        val parsed = BridgeProtocol.parse("""{"v":1,"id":"req-1","method":"scan.start","params":{"projectId":"p1"}}""")
        val request = (parsed as BridgeProtocol.Parsed.Ok).request
        assertEquals("req-1", request.id)
        assertEquals("scan.start", request.method)
        assertEquals("p1", request.params["projectId"]?.jsonPrimitive?.content)
    }

    @Test
    fun paramsAreOptional() {
        val parsed = BridgeProtocol.parse("""{"v":1,"id":"a","method":"bridge.hello"}""") as BridgeProtocol.Parsed.Ok
        assertTrue(parsed.request.params.isEmpty())
    }

    @Test
    fun rejectsMalformedMessages() {
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error(null).code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("not json").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("[1,2]").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"id":"a","method":"bridge.hello"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":2,"id":"a","method":"bridge.hello"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":"1","id":"a","method":"bridge.hello"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":1,"method":"bridge.hello"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":1,"id":7,"method":"bridge.hello"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":1,"id":"has space","method":"bridge.hello"}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":1,"id":"a","method":5}""").code)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":1,"id":"a","method":"scan.list","params":[1]}""").code)
    }

    @Test
    fun keepsTheIdWhenItCanBeRead() {
        assertEquals("abc", error("""{"v":3,"id":"abc","method":"bridge.hello"}""").id)
        assertEquals("", error("""{"v":1,"id":"${"x".repeat(200)}","method":"bridge.hello"}""").id)
    }

    @Test
    fun rejectsUnknownMethods() {
        val e = error("""{"v":1,"id":"a","method":"file.read","params":{"path":"/etc/hosts"}}""")
        assertEquals(BridgeErrorCode.UNKNOWN_METHOD, e.code)
        assertEquals("a", e.id)
    }

    @Test
    fun enforcesThe64KiBLimitInBytes() {
        val padding = "x".repeat(BridgeProtocol.MAX_MESSAGE_BYTES)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":1,"id":"a","method":"scan.list","params":{"p":"$padding"}}""").code)
        // 30k three-byte characters: under 64 KiB in chars, over it in UTF-8 bytes.
        val wide = "€".repeat(30_000)
        assertEquals(BridgeErrorCode.INVALID_REQUEST, error("""{"v":1,"id":"a","method":"scan.list","params":{"p":"$wide"}}""").code)
        val fits = "y".repeat(60_000)
        assertTrue(BridgeProtocol.parse("""{"v":1,"id":"a","method":"scan.list","params":{"p":"$fits"}}""") is BridgeProtocol.Parsed.Ok)
    }

    @Test
    fun envelopesMatchTheContract() {
        val ok = Json.parseToJsonElement(BridgeProtocol.okReply("r1", buildJsonObject { put("x", 1) })).jsonObject
        assertEquals(1, ok["v"]!!.jsonPrimitive.int)
        assertEquals("r1", ok["id"]!!.jsonPrimitive.content)
        assertTrue(ok["ok"]!!.jsonPrimitive.boolean)
        assertEquals(1, ok["result"]!!.jsonObject["x"]!!.jsonPrimitive.int)

        val err = Json.parseToJsonElement(BridgeProtocol.errorReply("r2", BridgeErrorCode.BUSY, "busy now")).jsonObject
        assertFalse(err["ok"]!!.jsonPrimitive.boolean)
        assertEquals("busy", err["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        assertEquals("busy now", err["error"]!!.jsonObject["message"]!!.jsonPrimitive.content)

        val event = Json.parseToJsonElement(BridgeProtocol.event("scan.progress", JsonObject(mapOf("keyframes" to JsonPrimitive(3))))).jsonObject
        assertEquals(setOf("v", "event", "data"), event.keys)
        assertEquals("scan.progress", event["event"]!!.jsonPrimitive.content)
    }

    @Test
    fun errorCodesAreTheContractSet() {
        assertEquals(
            setOf("forbidden", "invalid_request", "unknown_method", "unsupported", "permission_denied", "busy", "not_found", "upload_failed", "internal"),
            BridgeErrorCode.entries.map { it.wire }.toSet(),
        )
    }

    @Test
    fun methodsAreTheContractSet() {
        assertEquals(
            listOf("bridge.hello", "capabilities.get", "scan.start", "scan.list", "scan.upload", "scan.discard", "scan.markAttached"),
            BridgeProtocol.METHODS,
        )
    }
}
