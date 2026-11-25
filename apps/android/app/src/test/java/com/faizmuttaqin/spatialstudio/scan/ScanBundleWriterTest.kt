package com.faizmuttaqin.spatialstudio.scan

import com.faizmuttaqin.spatialstudio.util.Hashing
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Checks the written bundle against CAPTURE_CONTRACT.md and Capture Manifest V2. */
class ScanBundleWriterTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun read(file: File): JsonObject = Json.parseToJsonElement(file.readText()).jsonObject

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content

    private fun finalize(): Pair<File, FinalizedBundle> {
        val dir = tmp.newFolder(TestBundles.SESSION_ID)
        val bundle = ScanBundleWriter(dir).finalize(TestBundles.write(dir))
        // Optional: keep a copy for validating against the TypeScript schemas.
        System.getenv("SCAN_BUNDLE_FIXTURE_DIR")?.let { out -> dir.copyRecursively(File(out), overwrite = true) }
        return dir to bundle
    }

    @Test
    fun manifestIsCaptureV2WithContractFramesAndClocks() {
        val (dir, _) = finalize()
        val manifest = read(File(dir, "manifest.json"))
        assertEquals(2, manifest.getValue("schemaVersion").jsonPrimitive.int)
        assertEquals(TestBundles.SESSION_ID, manifest.str("sessionId"))
        assertEquals("project-1", manifest.str("projectId"))
        assertEquals("ready", manifest.str("state"))

        val clocks = manifest.getValue("clocks").jsonArray.map { it.jsonObject }
        assertEquals(listOf("device", "wall"), clocks.map { it.str("id") })
        assertEquals(listOf("nanoseconds", "milliseconds"), clocks.map { it.str("timebase") })
        assertEquals("unix", clocks[1].str("epoch"))

        val frames = manifest.getValue("coordinateFrames").jsonArray.map { it.jsonObject }
        assertEquals("world", frames.single().str("id"))
        assertEquals("arcore-world", frames.single().str("convention"))
    }

    @Test
    fun streamsMatchTheContractTable() {
        val (dir, _) = finalize()
        val streams = read(File(dir, "manifest.json")).getValue("streams").jsonArray.map { it.jsonObject }
        val kindsToRoles = streams.associate { it.str("kind") to it.str("role") }
        assertEquals(
            mapOf(
                "device-motion" to "deviceMotion",
                "rgb-keyframes" to "photos",
                "depth-keyframes" to "depth",
                "point-cloud" to "pointCloud",
                "plane-set" to "planes",
                "device-capabilities" to "capabilities",
            ),
            kindsToRoles,
        )
        assertEquals(streams.size, streams.map { it.str("id") }.toSet().size)
        streams.forEach { assertEquals("ready", it.str("availability")) }
    }

    @Test
    fun artifactsAreContentAddressedAndMatchTheFiles() {
        val (dir, bundle) = finalize()
        val streams = read(File(dir, "manifest.json")).getValue("streams").jsonArray.map { it.jsonObject }
        val withArtifacts = streams.filter { "artifact" in it }
        assertEquals(4, withArtifacts.size)
        for (stream in withArtifacts) {
            val artifact = stream.getValue("artifact").jsonObject
            val sha = artifact.str("sha256")
            assertTrue(Regex("^[0-9a-f]{64}$").matches(sha))
            assertEquals("/api/artifacts/$sha", artifact.str("uri"))
            assertEquals("application/json", artifact.str("mediaType"))
            assertEquals("${TestBundles.SESSION_ID}:${stream.str("id")}", artifact.str("id"))
            val file = bundle.artifacts.single { it.sha256 == sha }
            assertEquals(Hashing.sha256Hex(File(dir, file.path)), sha)
            assertEquals(File(dir, file.path).length(), artifact.getValue("byteLength").jsonPrimitive.long)
        }
        assertEquals(Hashing.sha256Hex(File(dir, "manifest.json")), bundle.manifest.sha256)
    }

    @Test
    fun inlineStreamsHaveContractPayloads() {
        val (dir, _) = finalize()
        val streams = read(File(dir, "manifest.json")).getValue("streams").jsonArray.map { it.jsonObject }
        val motion = streams.single { it.str("kind") == "device-motion" }
        assertEquals("device", motion.str("clockId"))
        val trajectory = motion.getValue("inline").jsonObject
        assertEquals("arcore-world", trajectory.str("coordinateSystem"))
        val samples = trajectory.getValue("samples").jsonArray.map { it.jsonObject }
        assertEquals(listOf(0, 0, 1), samples.map { it.getValue("segment").jsonPrimitive.int })
        samples.forEach { assertEquals(16, it.getValue("transform").jsonArray.size) }
        assertEquals(0.5, samples[2].getValue("transform").jsonArray[12].jsonPrimitive.content.toDouble(), 1e-9)

        val capabilities = streams.single { it.str("kind") == "device-capabilities" }.getValue("inline").jsonObject
        assertEquals(setOf("probedAt", "browser", "native"), capabilities.keys)
        assertEquals(JsonNull, capabilities["browser"])
        assertEquals("supported_installed", capabilities.getValue("native").jsonObject.getValue("arcore").jsonObject.str("availability"))
    }

    @Test
    fun keyframeIndexEntriesHaveContractFields() {
        val (dir, bundle) = finalize()
        val frames = read(File(dir, "keyframes.json")).getValue("frames").jsonArray.map { it.jsonObject }
        assertEquals(2, frames.size)
        frames.forEach {
            assertEquals(setOf("id", "timestamp", "image", "width", "height", "intrinsics", "pose", "trackingState"), it.keys)
            assertEquals("tracking", it.str("trackingState"))
            assertEquals(16, it.getValue("pose").jsonArray.size)
        }
        val image = frames[0].getValue("image").jsonObject
        val jpeg = bundle.artifacts.single { it.path == "keyframes/kf-0001.jpg" }
        assertEquals("image/jpeg", jpeg.mediaType)
        assertEquals(jpeg.sha256, image.str("sha256"))
        assertEquals("/api/artifacts/${jpeg.sha256}", image.str("uri"))
        assertEquals(setOf("fx", "fy", "cx", "cy"), frames[0].getValue("intrinsics").jsonObject.keys)
        assertEquals(JsonNull, frames[1]["intrinsics"])
    }

    @Test
    fun depthIndexPointsAtRawUint16AndConfidence() {
        val (dir, bundle) = finalize()
        val frame = read(File(dir, "depth.json")).getValue("frames").jsonArray.single().jsonObject
        assertEquals("kf-0001", frame.str("rgbKeyframeId"))
        assertEquals(4, frame.getValue("width").jsonPrimitive.int)
        assertEquals(3, frame.getValue("height").jsonPrimitive.int)
        val depth = bundle.artifacts.single { it.path == "depth/depth-0001.u16" }
        assertEquals("application/octet-stream", depth.mediaType)
        assertEquals(4L * 3 * 2, depth.byteLength)
        assertEquals(depth.sha256, frame.getValue("depth").jsonObject.str("sha256"))
        assertTrue(frame.getValue("confidence") is JsonObject)
        assertEquals("raw", frame.str("kind"))
    }

    @Test
    fun planeSetKeepsOnlyRepresentablePlanes() {
        val (dir, _) = finalize()
        val planes = read(File(dir, "planes.json")).getValue("planes").jsonArray.map { it.jsonObject }
        assertEquals(listOf("plane-1", "plane-2"), planes.map { it.str("id") })
        assertEquals(listOf("horizontal-up", "vertical"), planes.map { it.str("orientation") })
        assertEquals("plane-1", planes[1].str("subsumedBy"))
        assertEquals(JsonNull, planes[0]["subsumedBy"])
        planes.forEach { plane ->
            assertEquals(16, plane.getValue("centerPose").jsonArray.size)
            assertEquals(2, plane.getValue("extent").jsonArray.size)
            val polygon = plane.getValue("polygon").jsonArray
            assertTrue(polygon.size >= 3)
            polygon.forEach { assertEquals(2, (it as JsonArray).size) }
        }
    }

    @Test
    fun pointCloudIsAPointCloudPayload() {
        val (dir, _) = finalize()
        val cloud = read(File(dir, "pointcloud.json"))
        assertEquals("arcore-world", cloud.str("coordinateSystem"))
        assertEquals(6, cloud.getValue("positions").jsonArray.size)
        assertFalse("colors" in cloud)
    }

    @Test
    fun metadataMatchesTheContract() {
        val (dir, _) = finalize()
        val metadata = read(File(dir, "manifest.json")).getValue("metadata").jsonObject
        assertEquals("android-arcore", metadata.str("provider"))
        assertEquals("0.1.0-test", metadata.str("appVersion"))
        assertEquals(1, metadata.getValue("bridgeVersion").jsonPrimitive.int)
        assertEquals(setOf("manufacturer", "model", "os"), metadata.getValue("device").jsonObject.keys)
        assertEquals("2025-11-25T08:00:00.000Z", metadata.str("createdAt"))
        assertEquals(1, metadata.getValue("trackingLossCount").jsonPrimitive.int)
        assertEquals(1, metadata.getValue("warnings").jsonArray.size)
        val camera = metadata.getValue("camera").jsonObject
        assertEquals("opengl", camera.str("convention"))
        assertEquals("image-readout", camera.str("frame"))
        assertEquals(90, camera.getValue("sensorOrientationDeg").jsonPrimitive.int)
    }

    @Test
    fun leavesOutKeyframesWhoseFilesAreMissing() {
        val dir = tmp.newFolder("missing")
        val input = TestBundles.write(dir)
        File(dir, "keyframes/kf-0001.jpg").delete()
        val bundle = ScanBundleWriter(dir).finalize(input)
        val frames = read(File(dir, "keyframes.json")).getValue("frames").jsonArray.map { it.jsonObject.str("id") }
        assertEquals(listOf("kf-0002"), frames)
        // Its depth frame goes with it.
        assertFalse(File(dir, "depth.json").exists())
        assertFalse(bundle.artifacts.any { it.path.startsWith("depth/") })
        val warnings = read(File(dir, "manifest.json")).getValue("metadata").jsonObject.getValue("warnings").jsonArray
            .map { it.jsonPrimitive.content }
        assertTrue("keyframe-file-missing" in warnings)
        assertTrue("depth-file-missing" in warnings)
    }

    @Test
    fun uploadPlanSendsImagesBeforeIndicesAndManifestLast() {
        val (dir, bundle) = finalize()
        val plan = UploadPlanFile.read(File(dir, ScanBundle.UPLOAD_PLAN_FILE))
        assertEquals(bundle.manifest.sha256, plan.manifest.sha256)
        assertFalse(plan.artifacts.any { it.path == "manifest.json" })
        val order = plan.artifacts.map { it.path }
        assertTrue(order.indexOf("keyframes/kf-0001.jpg") < order.indexOf("keyframes.json"))
        assertTrue(order.indexOf("depth/depth-0001.u16") < order.indexOf("depth.json"))
        assertEquals(
            setOf(
                "keyframes/kf-0001.jpg", "keyframes/kf-0002.jpg", "keyframes.json",
                "depth/depth-0001.u16", "depth/depth-0001.conf.u8", "depth.json",
                "pointcloud.json", "planes.json",
            ),
            order.toSet(),
        )
    }

    @Test
    fun omitsStreamsWithoutData() {
        val dir = tmp.newFolder("empty")
        val full = TestBundles.write(dir)
        val empty = BundleInput(
            full.sessionId, null, full.createdAtMs, full.appVersion, full.device, full.nativeCapabilities,
            full.capabilitiesProbedAtMs, trajectory = full.trajectory.take(1), keyframes = emptyList(), depth = emptyList(),
            planes = emptyList(), points = FloatArray(0), voxelSizeM = 0.02, minConfidence = 0.3f,
            trackingLossCount = 0, warnings = emptyList(), startTimestampNs = null, sensorOrientationDeg = null,
            arcore = JsonObject(emptyMap()),
        )
        val bundle = ScanBundleWriter(dir).finalize(empty)
        val manifest = read(File(dir, "manifest.json"))
        assertFalse("projectId" in manifest)
        assertEquals(listOf("device-capabilities"), manifest.getValue("streams").jsonArray.map { it.jsonObject.str("kind") })
        assertTrue(bundle.artifacts.isEmpty())
    }
}
