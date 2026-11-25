package com.faizmuttaqin.spatialstudio.scan

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.io.File

/** Synthetic scan bundles; no real capture data. */
object TestBundles {
    const val SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e"

    fun write(
        dir: File,
        sessionId: String = SESSION_ID,
        sensors: SensorCapture? = null,
        lightEstimates: List<LightRecord> = emptyList(),
        boundaryMarks: List<BoundaryMark> = emptyList(),
    ): BundleInput {
        File(dir, "keyframes").mkdirs()
        File(dir, "depth").mkdirs()
        File(dir, "keyframes/kf-0001.jpg").writeBytes(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3))
        File(dir, "keyframes/kf-0002.jpg").writeBytes(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 4, 5, 6, 7))
        File(dir, "depth/depth-0001.u16").writeBytes(ByteArray(4 * 3 * 2) { it.toByte() })
        File(dir, "depth/depth-0001.conf.u8").writeBytes(ByteArray(4 * 3) { 200.toByte() })

        val square = floatArrayOf(-1f, -1f, 1f, -1f, 1f, 1f, -1f, 1f)
        return BundleInput(
            sessionId = sessionId,
            projectId = "project-1",
            createdAtMs = 1_764_057_600_000L,
            appVersion = "0.1.0-test",
            device = DeviceInfo("TestMaker", "Test Phone", "Android 15 (SDK 35)"),
            nativeCapabilities = buildJsonObject {
                putJsonObject("arcore") {
                    put("availability", "supported_installed")
                    put("depth", true)
                    put("rawDepth", true)
                }
                put("cameras", kotlinx.serialization.json.JsonArray(emptyList()))
                putJsonObject("sensors") { put("barometer", JsonPrimitive(true)) }
                putJsonObject("device") {
                    put("manufacturer", "TestMaker")
                    put("model", "Test Phone")
                    put("sdkInt", 35)
                    put("webViewVersion", "131.0.0.0")
                }
            },
            capabilitiesProbedAtMs = 1_764_057_600_500L,
            trajectory = listOf(
                TrajectorySample(0, 1_000_000_000L, Matrices.pose()),
                TrajectorySample(0, 1_100_000_000L, Matrices.pose(x = 0.1f)),
                TrajectorySample(1, 2_000_000_000L, Matrices.pose(x = 0.5f, yawDeg = 30.0)),
            ),
            keyframes = listOf(
                KeyframeRecord("kf-0001", 1_000_000_000L, "keyframes/kf-0001.jpg", 1920, 1080, Intrinsics(1500.0, 1500.0, 960.0, 540.0), Matrices.pose(), "tracking"),
                KeyframeRecord("kf-0002", 2_000_000_000L, "keyframes/kf-0002.jpg", 1920, 1080, null, Matrices.pose(x = 0.5f, yawDeg = 30.0), "tracking"),
            ),
            depth = listOf(
                DepthRecord("depth-0001", "kf-0001", 1_000_000_100L, 4, 3, "depth/depth-0001.u16", "depth/depth-0001.conf.u8", "raw", Intrinsics(3.1, 3.1, 2.0, 1.5)),
            ),
            planes = listOf(
                PlaneRecord("plane-1", "horizontal-up", Matrices.pose(y = -1.4f), 2f, 2f, square, null, "tracking"),
                PlaneRecord("plane-2", "vertical", Matrices.pose(z = -2f, yawDeg = 90.0), 3f, 2.5f, square, "plane-1", "tracking"),
                PlaneRecord("plane-3", "vertical", Matrices.pose(), 0.1f, 0.1f, floatArrayOf(0f, 0f, 1f, 1f), null, "tracking"),
            ),
            points = floatArrayOf(0f, 0f, -1f, 0.5f, 1.2f, -2f),
            voxelSizeM = 0.02,
            minConfidence = 0.3f,
            trackingLossCount = 1,
            warnings = listOf("no-planes-detected-test"),
            startTimestampNs = 1_000_000_000L,
            sensorOrientationDeg = 90,
            arcore = buildJsonObject { put("depthKind", "raw") },
            sensors = sensors,
            lightEstimates = lightEstimates,
            boundaryMarks = boundaryMarks,
        )
    }
}
