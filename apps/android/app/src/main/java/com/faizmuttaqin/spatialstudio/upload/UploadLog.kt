package com.faizmuttaqin.spatialstudio.upload

import java.io.File
import java.io.FileOutputStream

/**
 * Append-only record of artifacts a studio origin has confirmed storing, kept in
 * the session directory so an interrupted upload resumes where it stopped.
 * One line per artifact: `<origin> <sha256>`.
 */
class UploadLog(private val file: File) {

    fun stored(origin: String): Set<String> {
        if (!file.isFile) return emptySet()
        return file.readLines().mapNotNullTo(HashSet()) { line ->
            val parts = line.trim().split(' ')
            if (parts.size == 2 && parts[0] == origin && SHA256.matches(parts[1])) parts[1] else null
        }
    }

    fun record(origin: String, sha256: String) {
        require(SHA256.matches(sha256)) { "Not a sha256" }
        FileOutputStream(file, true).use { out ->
            out.write("$origin $sha256\n".toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
    }

    companion object {
        const val FILE = "upload-log.txt"
        private val SHA256 = Regex("^[0-9a-f]{64}$")
    }
}
