package com.faizmuttaqin.spatialstudio.live

import java.io.ByteArrayInputStream
import java.io.EOFException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WebSocketFramingTest {
    private val origin = "https://spatial-studio.example"
    private val origins = setOf(origin)
    private val token = "0123456789abcdef0123456789abcdef"
    private val key = "dGhlIHNhbXBsZSBub25jZQ=="

    private fun head(
        path: String = "/live?t=$token",
        host: String = "127.0.0.1:4321",
        originHeader: String? = origin,
        extra: String = "",
    ) = buildString {
        append("GET $path HTTP/1.1\r\n")
        append("Host: $host\r\n")
        append("Upgrade: websocket\r\n")
        append("Connection: keep-alive, Upgrade\r\n")
        append("Sec-WebSocket-Key: $key\r\n")
        append("Sec-WebSocket-Version: 13")
        if (originHeader != null) append("\r\nOrigin: $originHeader")
        append(extra)
    }

    private fun verdict(head: String) = WebSocketFraming.handshake(head, 4321, token, origins)

    private fun rejectedWith(head: String): Int = (verdict(head) as WebSocketFraming.Handshake.Rejected).status

    @Test
    fun acceptKeyMatchesRfc6455Example() {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", WebSocketFraming.acceptKey(key))
        assertEquals("Zm9vYg==", WebSocketFraming.base64("foob".toByteArray()))
        assertEquals("Zm9v", WebSocketFraming.base64("foo".toByteArray()))
        assertEquals("Zm8=", WebSocketFraming.base64("fo".toByteArray()))
    }

    @Test
    fun acceptsAMatchingHandshake() {
        val ok = verdict(head()) as WebSocketFraming.Handshake.Ok
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", ok.accept)
        assertNotNull(verdict(head(host = "localhost:4321")) as? WebSocketFraming.Handshake.Ok)
    }

    @Test
    fun rejectsAnOtherOrNoOrigin() {
        assertEquals(403, rejectedWith(head(originHeader = "https://evil.example")))
        assertEquals(403, rejectedWith(head(originHeader = "https://spatial-studio.example.evil.test")))
        assertEquals(403, rejectedWith(head(originHeader = "null")))
        assertEquals(403, rejectedWith(head(originHeader = null)))
    }

    @Test
    fun rejectsABadOrMissingToken() {
        assertEquals(403, rejectedWith(head(path = "/live?t=$token" + "0")))
        assertEquals(403, rejectedWith(head(path = "/live?t=")))
        assertEquals(403, rejectedWith(head(path = "/live")))
        assertEquals(403, rejectedWith(head(path = "/live?x=1&t=nope")))
    }

    @Test
    fun rejectsAForeignHostAgainstRebinding() {
        assertEquals(403, rejectedWith(head(host = "evil.example:4321")))
        assertEquals(403, rejectedWith(head(host = "127.0.0.1:4322")))
        assertEquals(403, rejectedWith(head(host = "127.0.0.1")))
    }

    @Test
    fun rejectsWrongMethodPathAndUpgrade() {
        assertEquals(404, rejectedWith(head(path = "/other?t=$token")))
        assertEquals(400, rejectedWith(head().replaceFirst("GET", "POST")))
        assertEquals(400, rejectedWith(head().replace("Upgrade: websocket", "Upgrade: h2c")))
        assertEquals(400, rejectedWith(head().replace("Sec-WebSocket-Version: 13", "Sec-WebSocket-Version: 8")))
        assertEquals(400, rejectedWith(head().replace(key, "short")))
        assertEquals(400, rejectedWith(head(extra = "\r\nOrigin: $origin")))
        assertEquals(400, rejectedWith(head(extra = "\r\nno colon here")))
    }

    @Test
    fun readHeadStopsAtTheBlankLineAndIsBounded() {
        val text = head() + "\r\n\r\nGARBAGE"
        assertEquals(head(), WebSocketFraming.readHead(ByteArrayInputStream(text.toByteArray())))
        assertNull(WebSocketFraming.readHead(ByteArrayInputStream(ByteArray(WebSocketFraming.MAX_HEAD_BYTES + 10) { 'a'.code.toByte() })))
        assertNull(WebSocketFraming.readHead(ByteArrayInputStream("GET / HTTP/1.1\r\n".toByteArray())))
    }

    @Test
    fun serverFramesUseTheRightLengthForm() {
        assertArrayEquals(byteArrayOf(0x82.toByte(), 3, 1, 2, 3), WebSocketFraming.frame(WebSocketFraming.OP_BINARY, byteArrayOf(1, 2, 3)))
        val mid = WebSocketFraming.frame(WebSocketFraming.OP_BINARY, ByteArray(300))
        assertEquals(126, mid[1].toInt())
        assertEquals(300, (mid[2].toInt() and 0xFF shl 8) or (mid[3].toInt() and 0xFF))
        assertEquals(4 + 300, mid.size)
        val big = WebSocketFraming.frame(WebSocketFraming.OP_BINARY, ByteArray(70_000))
        assertEquals(127, big[1].toInt())
        assertEquals(70_000, (big[6].toInt() and 0xFF shl 24) or (big[7].toInt() and 0xFF shl 16) or (big[8].toInt() and 0xFF shl 8) or (big[9].toInt() and 0xFF))
        assertEquals(10 + 70_000, big.size)
        assertArrayEquals(byteArrayOf(0x88.toByte(), 2, 0x03, 0xE8.toByte()), WebSocketFraming.closeFrame(1000))
    }

    private fun clientFrame(first: Int, payload: ByteArray, masked: Boolean = true, length: Int = payload.size): ByteArray {
        val mask = byteArrayOf(1, 2, 3, 4)
        val body = if (masked) ByteArray(payload.size) { (payload[it].toInt() xor mask[it % 4].toInt()).toByte() } else payload
        return byteArrayOf(first.toByte(), ((if (masked) 0x80 else 0) or length).toByte()) + (if (masked) mask else ByteArray(0)) + body
    }

    @Test
    fun readsMaskedControlFrames() {
        val ping = WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0x89, byteArrayOf(9, 8, 7))))!!
        assertEquals(WebSocketFraming.OP_PING, ping.opcode)
        assertArrayEquals(byteArrayOf(9, 8, 7), ping.payload)
        assertEquals(WebSocketFraming.OP_CLOSE, WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0x88, byteArrayOf())))!!.opcode)
    }

    @Test
    fun refusesDataUnmaskedFragmentedAndOversizedClientFrames() {
        assertNull(WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0x82, byteArrayOf(1)))))
        assertNull(WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0x81, byteArrayOf(1)))))
        assertNull(WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0x89, byteArrayOf(1), masked = false))))
        assertNull(WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0x09, byteArrayOf(1)))))
        assertNull(WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0x89, ByteArray(0), length = 126))))
        assertNull(WebSocketFraming.readClientFrame(ByteArrayInputStream(clientFrame(0xC9, byteArrayOf(1)))))
    }

    @Test
    fun aTruncatedFrameEndsTheStream() {
        try {
            WebSocketFraming.readClientFrame(ByteArrayInputStream(byteArrayOf(0x89.toByte(), 0x83.toByte(), 1)))
            fail("expected end of stream")
        } catch (e: EOFException) {
            assertTrue(true)
        }
    }

    @Test
    fun constantTimeEqualsComparesContent() {
        assertTrue(WebSocketFraming.constantTimeEquals("abc", "abc"))
        assertTrue(!WebSocketFraming.constantTimeEquals("abc", "abd"))
        assertTrue(!WebSocketFraming.constantTimeEquals("abc", "abcd"))
    }
}
