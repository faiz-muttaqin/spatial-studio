package com.faizmuttaqin.spatialstudio.live

import java.io.InputStream
import java.security.MessageDigest

/**
 * The small part of RFC 6455 the loopback preview server needs: the opening handshake (with the
 * Origin, Host and token checks) and server-to-client binary frames. No Android types.
 */
object WebSocketFraming {
    const val MAX_HEAD_BYTES = 4 * 1024
    /** The page never sends data; a control frame fits well under this. */
    const val MAX_CLIENT_PAYLOAD = 125
    const val PATH = "/live"
    /** A 16 byte nonce in base64. `java.util.Base64` needs API 26 and the app supports 24, so it is encoded by hand. */
    private val KEY_PATTERN = Regex("^[A-Za-z0-9+/]{22}==$")
    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    sealed interface Handshake {
        /** Accept; [accept] is the `Sec-WebSocket-Accept` value. */
        class Ok(val accept: String) : Handshake
        class Rejected(val status: Int, val reason: String) : Handshake
    }

    /**
     * Checks the request head (request line and headers, without the blank line). Rejects, in order: a wrong
     * method or path (404), a missing token or one that does not match (403), a missing or different Origin
     * (403), a Host that is not the loopback address on [port] (403; blocks DNS rebinding), and a malformed
     * upgrade (400). [expectedToken] is compared in constant time.
     */
    fun handshake(head: String, port: Int, expectedToken: String, allowedOrigins: Set<String>): Handshake {
        val lines = head.split("\r\n")
        val request = lines.firstOrNull()?.split(" ") ?: return rejected(400, "bad request")
        if (request.size != 3 || request[0] != "GET" || request[2] != "HTTP/1.1") return rejected(400, "bad request")
        val target = request[1]
        val path = target.substringBefore('?')
        if (path != PATH) return rejected(404, "not found")
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val i = line.indexOf(':')
            if (i <= 0) return rejected(400, "bad header")
            // A repeated header is ambiguous; refuse it rather than pick one.
            if (headers.put(line.substring(0, i).trim().lowercase(), line.substring(i + 1).trim()) != null) return rejected(400, "duplicate header")
        }
        val token = target.substringAfter('?', "").split('&').firstOrNull { it.startsWith("t=") }?.substring(2)
        if (token == null || !constantTimeEquals(token, expectedToken)) return rejected(403, "forbidden")
        val origin = headers["origin"]
        if (origin == null || origin !in allowedOrigins) return rejected(403, "forbidden")
        val host = headers["host"]
        if (host != "127.0.0.1:$port" && host != "localhost:$port") return rejected(403, "forbidden")
        val upgrade = headers["upgrade"]?.lowercase()
        val connection = headers["connection"]?.lowercase()?.split(',')?.map { it.trim() }.orEmpty()
        val key = headers["sec-websocket-key"]
        if (upgrade != "websocket" || "upgrade" !in connection || headers["sec-websocket-version"] != "13" ||
            key == null || !KEY_PATTERN.matches(key)
        ) {
            return rejected(400, "bad upgrade")
        }
        return Handshake.Ok(acceptKey(key))
    }

    private fun rejected(status: Int, reason: String) = Handshake.Rejected(status, reason)

    fun acceptKey(key: String): String =
        base64(MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.US_ASCII)))

    fun base64(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size + 2) / 3 * 4)
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xFF else 0
            val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xFF else 0
            out.append(B64[b0 shr 2]).append(B64[(b0 and 3) shl 4 or (b1 shr 4)])
            out.append(if (i + 1 < bytes.size) B64[(b1 and 15) shl 2 or (b2 shr 6)] else '=')
            out.append(if (i + 2 < bytes.size) B64[b2 and 63] else '=')
            i += 3
        }
        return out.toString()
    }

    fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    fun responseOk(accept: String): ByteArray =
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n"
            .toByteArray(Charsets.US_ASCII)

    fun responseError(status: Int, reason: String): ByteArray =
        "HTTP/1.1 $status $reason\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".toByteArray(Charsets.US_ASCII)

    /** Reads up to the blank line; null past [MAX_HEAD_BYTES] or at end of stream. */
    fun readHead(input: InputStream): String? {
        val out = java.io.ByteArrayOutputStream()
        var tail = 0
        while (out.size() < MAX_HEAD_BYTES) {
            val b = input.read()
            if (b < 0) return null
            out.write(b)
            tail = if (b == '\r'.code && (tail == 0 || tail == 2)) tail + 1 else if (b == '\n'.code && (tail == 1 || tail == 3)) tail + 1 else 0
            if (tail == 4) return String(out.toByteArray(), Charsets.US_ASCII).removeSuffix("\r\n\r\n")
        }
        return null
    }

    const val OP_BINARY = 0x2
    const val OP_CLOSE = 0x8
    const val OP_PING = 0x9
    const val OP_PONG = 0xA

    /** One unmasked, unfragmented server frame. */
    fun frame(opcode: Int, payload: ByteArray): ByteArray {
        val n = payload.size
        val head = when {
            n <= 125 -> byteArrayOf((0x80 or opcode).toByte(), n.toByte())
            n <= 0xFFFF -> byteArrayOf((0x80 or opcode).toByte(), 126, (n shr 8).toByte(), n.toByte())
            else -> byteArrayOf(
                (0x80 or opcode).toByte(), 127, 0, 0, 0, 0,
                (n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte(),
            )
        }
        return head + payload
    }

    fun closeFrame(code: Int): ByteArray = frame(OP_CLOSE, byteArrayOf((code shr 8).toByte(), code.toByte()))

    class ClientFrame(val opcode: Int, val payload: ByteArray)

    /**
     * Reads one client frame. Client frames must be masked, unfragmented and at most [MAX_CLIENT_PAYLOAD]
     * bytes; anything else returns null and the connection is closed. Throws on end of stream.
     */
    fun readClientFrame(input: InputStream): ClientFrame? {
        val b0 = readByte(input)
        val b1 = readByte(input)
        val fin = b0 and 0x80 != 0
        val opcode = b0 and 0x0F
        val masked = b1 and 0x80 != 0
        val length = b1 and 0x7F
        if (!fin || b0 and 0x70 != 0 || !masked || length > MAX_CLIENT_PAYLOAD) return null
        if (opcode != OP_CLOSE && opcode != OP_PING && opcode != OP_PONG) return null
        val mask = ByteArray(4) { readByte(input).toByte() }
        val payload = ByteArray(length) { (readByte(input) xor (mask[it % 4].toInt() and 0xFF)).toByte() }
        return ClientFrame(opcode, payload)
    }

    private fun readByte(input: InputStream): Int {
        val b = input.read()
        if (b < 0) throw java.io.EOFException()
        return b
    }
}
