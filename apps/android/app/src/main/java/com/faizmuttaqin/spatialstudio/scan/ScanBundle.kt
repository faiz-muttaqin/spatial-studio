package com.faizmuttaqin.spatialstudio.scan

import com.faizmuttaqin.spatialstudio.bridge.BridgeProtocol
import com.faizmuttaqin.spatialstudio.util.Hashing
import com.faizmuttaqin.spatialstudio.util.JsonUtil
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.File

class KeyframeRecord(
    val id: String,
    val timestampNs: Long,
    /** Path relative to the session directory. */
    val imagePath: String,
    val width: Int,
    val height: Int,
    val intrinsics: Intrinsics?,
    val pose: FloatArray?,
    val trackingState: String,
)

class DepthRecord(
    val id: String,
    val rgbKeyframeId: String,
    val timestampNs: Long,
    val width: Int,
    val height: Int,
    val depthPath: String,
    val confidencePath: String?,
    /** `raw` (ARCore raw depth plus confidence) or `smoothed` (full depth). */
    val kind: String,
    val intrinsics: Intrinsics,
)

class PlaneRecord(
    val id: String,
    /** `horizontal-up`, `horizontal-down` or `vertical`. */
    val orientation: String,
    val centerPose: FloatArray,
    val extentX: Float,
    val extentZ: Float,
    /** Plane-local `x, z` pairs in metres. */
    val polygon: FloatArray,
    val subsumedBy: String?,
    val trackingState: String,
)

class DeviceInfo(val manufacturer: String?, val model: String?, val os: String?)

class BundleInput(
    val sessionId: String,
    val projectId: String?,
    val createdAtMs: Long,
    val appVersion: String,
    val device: DeviceInfo,
    /** `capabilities.get` result at capture time. */
    val nativeCapabilities: JsonObject,
    val capabilitiesProbedAtMs: Long,
    val trajectory: List<TrajectorySample>,
    val keyframes: List<KeyframeRecord>,
    val depth: List<DepthRecord>,
    val planes: List<PlaneRecord>,
    /** Downsampled `x, y, z` triples in world metres. */
    val points: FloatArray,
    val voxelSizeM: Double,
    val minConfidence: Float,
    val trackingLossCount: Int,
    val warnings: List<String>,
    val startTimestampNs: Long?,
    /** `SENSOR_ORIENTATION` of the ARCore camera, recorded with the pose convention. */
    val sensorOrientationDeg: Int?,
    /** Extra provider details kept under `metadata.arcore`. */
    val arcore: JsonObject,
)

class ArtifactFile(val path: String, val sha256: String, val byteLength: Long, val mediaType: String) {
    val uri: String get() = ScanBundle.artifactUri(sha256)
}

class FinalizedBundle(val manifest: ArtifactFile, val artifacts: List<ArtifactFile>) {
    val totalBytes: Long get() = manifest.byteLength + artifacts.sumOf { it.byteLength }
}

/** Builds the Capture Manifest V2 scan bundle described in CAPTURE_CONTRACT.md. */
object ScanBundle {
    const val COORDINATE_SYSTEM = "arcore-world"
    const val PROVIDER = "android-arcore"
    const val MAX_ARTIFACT_BYTES = 16L * 1024 * 1024
    const val MANIFEST_FILE = "manifest.json"
    const val UPLOAD_PLAN_FILE = "artifacts.json"

    const val MEDIA_JSON = "application/json"
    const val MEDIA_JPEG = "image/jpeg"
    const val MEDIA_BINARY = "application/octet-stream"

    fun artifactUri(sha256: String) = "/api/artifacts/$sha256"

    fun pointer(file: ArtifactFile): JsonObject = buildJsonObject {
        put("uri", file.uri)
        put("sha256", file.sha256)
    }

    fun intrinsicsJson(value: Intrinsics): JsonObject = buildJsonObject {
        put("fx", JsonUtil.rounded(value.fx, 4))
        put("fy", JsonUtil.rounded(value.fy, 4))
        put("cx", JsonUtil.rounded(value.cx, 4))
        put("cy", JsonUtil.rounded(value.cy, 4))
    }

    fun keyframeIndex(frames: List<KeyframeRecord>, images: Map<String, ArtifactFile>): JsonObject = buildJsonObject {
        putJsonArray("frames") {
            for (frame in frames) {
                addJsonObject {
                    put("id", frame.id)
                    put("timestamp", frame.timestampNs)
                    put("image", pointer(images.getValue(frame.id)))
                    put("width", frame.width)
                    put("height", frame.height)
                    put("intrinsics", frame.intrinsics?.takeIf { it.isValid }?.let(::intrinsicsJson) ?: JsonNull)
                    put("pose", frame.pose?.takeIf(PoseMath::isFinite)?.let(JsonUtil::matrix) ?: JsonNull)
                    put("trackingState", frame.trackingState)
                }
            }
        }
    }

    fun depthIndex(
        frames: List<DepthRecord>,
        depthFiles: Map<String, ArtifactFile>,
        confidenceFiles: Map<String, ArtifactFile>,
    ): JsonObject = buildJsonObject {
        putJsonArray("frames") {
            for (frame in frames) {
                addJsonObject {
                    put("id", frame.id)
                    put("rgbKeyframeId", frame.rgbKeyframeId)
                    put("timestamp", frame.timestampNs)
                    put("width", frame.width)
                    put("height", frame.height)
                    put("intrinsics", intrinsicsJson(frame.intrinsics))
                    put("depth", pointer(depthFiles.getValue(frame.id)))
                    put("confidence", confidenceFiles[frame.id]?.let(::pointer) ?: JsonNull)
                    put("kind", frame.kind)
                }
            }
        }
    }

    fun planeSet(planes: List<PlaneRecord>): JsonObject = buildJsonObject {
        putJsonArray("planes") {
            for (plane in planes) {
                addJsonObject {
                    put("id", plane.id)
                    put("orientation", plane.orientation)
                    put("centerPose", JsonUtil.matrix(plane.centerPose))
                    put(
                        "extent",
                        buildJsonArray {
                            add(JsonUtil.rounded(plane.extentX.toDouble(), 4))
                            add(JsonUtil.rounded(plane.extentZ.toDouble(), 4))
                        },
                    )
                    putJsonArray("polygon") {
                        for (i in 0 until plane.polygon.size / 2) {
                            add(
                                buildJsonArray {
                                    add(JsonUtil.rounded(plane.polygon[i * 2].toDouble(), 4))
                                    add(JsonUtil.rounded(plane.polygon[i * 2 + 1].toDouble(), 4))
                                },
                            )
                        }
                    }
                    put("subsumedBy", plane.subsumedBy?.let(::JsonPrimitive) ?: JsonNull)
                    put("trackingState", plane.trackingState)
                }
            }
        }
    }

    fun pointCloud(points: FloatArray): JsonObject = buildJsonObject {
        put("coordinateSystem", COORDINATE_SYSTEM)
        put("positions", JsonArray(points.map { JsonUtil.rounded(it.toDouble(), 4) }))
    }

    fun trajectory(samples: List<TrajectorySample>): JsonObject = buildJsonObject {
        put("coordinateSystem", COORDINATE_SYSTEM)
        putJsonArray("samples") {
            for (sample in samples) {
                addJsonObject {
                    put("segment", sample.segment)
                    put("timestamp", sample.timestampNs)
                    put("transform", JsonUtil.matrix(sample.transform))
                }
            }
        }
    }

    /** Planes the contract can represent: at least three boundary points, finite values. */
    fun usablePlanes(planes: List<PlaneRecord>): List<PlaneRecord> = planes.filter { plane ->
        plane.polygon.size >= 6 && plane.polygon.size % 2 == 0 &&
            plane.polygon.all { it.isFinite() } && PoseMath.isFinite(plane.centerPose) &&
            plane.extentX.isFinite() && plane.extentZ.isFinite() && plane.subsumedBy != plane.id
    }

    fun artifactRef(sessionId: String, streamId: String, file: ArtifactFile): JsonObject = buildJsonObject {
        put("id", "$sessionId:$streamId")
        put("uri", file.uri)
        put("mediaType", file.mediaType)
        put("byteLength", file.byteLength)
        put("sha256", file.sha256)
    }
}

/** Writes indices, point cloud, planes, manifest and upload plan into a session directory. */
class ScanBundleWriter(private val dir: File) {

    fun finalize(input: BundleInput): FinalizedBundle {
        val artifacts = ArrayList<ArtifactFile>()
        val warnings = LinkedHashSet(input.warnings)

        fun register(path: String, mediaType: String): ArtifactFile {
            val file = File(dir, path)
            check(file.isFile) { "Missing artifact $path" }
            val length = file.length()
            check(length <= ScanBundle.MAX_ARTIFACT_BYTES) { "Artifact $path exceeds 16 MB" }
            return ArtifactFile(path, Hashing.sha256Hex(file), length, mediaType).also { artifacts.add(it) }
        }

        fun writeJson(path: String, element: JsonElement): ArtifactFile {
            JsonUtil.writeAtomically(File(dir, path), JsonUtil.encode(element).toByteArray(Charsets.UTF_8))
            return register(path, ScanBundle.MEDIA_JSON)
        }

        val sessionId = input.sessionId
        val streams = ArrayList<JsonObject>()

        if (input.trajectory.size >= 2) {
            streams += buildJsonObject {
                put("id", "device-motion")
                put("kind", "device-motion")
                put("role", "deviceMotion")
                put("availability", "ready")
                put("frameId", "world")
                put("clockId", "device")
                put("inline", ScanBundle.trajectory(input.trajectory))
                putJsonObject("metadata") {
                    put("source", "arcore")
                    put("sampleCount", input.trajectory.size)
                }
            }
        }

        // A keyframe or depth frame whose file is gone is left out with a warning instead of failing the save.
        val keyframes = input.keyframes.filter { File(dir, it.imagePath).isFile }
        if (keyframes.size < input.keyframes.size) warnings += "keyframe-file-missing"
        val keyframeIds = keyframes.mapTo(HashSet()) { it.id }
        val depthFrames = input.depth.filter { d ->
            d.rgbKeyframeId in keyframeIds && File(dir, d.depthPath).isFile && (d.confidencePath == null || File(dir, d.confidencePath).isFile)
        }
        if (depthFrames.size < input.depth.size) warnings += "depth-file-missing"

        if (keyframes.isNotEmpty()) {
            val images = keyframes.associate { it.id to register(it.imagePath, ScanBundle.MEDIA_JPEG) }
            val index = writeJson("keyframes.json", ScanBundle.keyframeIndex(keyframes, images))
            streams += buildJsonObject {
                put("id", "rgb-keyframes")
                put("kind", "rgb-keyframes")
                put("role", "photos")
                put("availability", "ready")
                put("frameId", "world")
                put("clockId", "device")
                put("artifact", ScanBundle.artifactRef(sessionId, "rgb-keyframes", index))
                putJsonObject("metadata") {
                    put("source", "arcore")
                    put("count", keyframes.size)
                }
            }
        }

        if (depthFrames.isNotEmpty()) {
            val depthFiles = depthFrames.associate { it.id to register(it.depthPath, ScanBundle.MEDIA_BINARY) }
            val confidenceFiles = depthFrames.mapNotNull { d ->
                d.confidencePath?.let { d.id to register(it, ScanBundle.MEDIA_BINARY) }
            }.toMap()
            val index = writeJson("depth.json", ScanBundle.depthIndex(depthFrames, depthFiles, confidenceFiles))
            streams += buildJsonObject {
                put("id", "depth-keyframes")
                put("kind", "depth-keyframes")
                put("role", "depth")
                put("availability", "ready")
                put("frameId", "world")
                put("clockId", "device")
                put("artifact", ScanBundle.artifactRef(sessionId, "depth-keyframes", index))
                putJsonObject("metadata") {
                    put("source", "arcore")
                    put("count", depthFrames.size)
                    put("encoding", "uint16-le-millimetres")
                    put("confidenceEncoding", "uint8")
                }
            }
        }

        if (input.points.size >= 3) {
            val cloud = writeJson("pointcloud.json", ScanBundle.pointCloud(input.points))
            streams += buildJsonObject {
                put("id", "point-cloud")
                put("kind", "point-cloud")
                put("role", "pointCloud")
                put("availability", "ready")
                put("frameId", "world")
                put("artifact", ScanBundle.artifactRef(sessionId, "point-cloud", cloud))
                putJsonObject("metadata") {
                    put("source", "arcore")
                    put("pointCount", input.points.size / 3)
                    put("voxelSizeM", input.voxelSizeM)
                    put("minConfidence", JsonUtil.rounded(input.minConfidence.toDouble(), 3))
                }
            }
        }

        val planes = ScanBundle.usablePlanes(input.planes)
        if (planes.isNotEmpty()) {
            val set = writeJson("planes.json", ScanBundle.planeSet(planes))
            streams += buildJsonObject {
                put("id", "plane-set")
                put("kind", "plane-set")
                put("role", "planes")
                put("availability", "ready")
                put("frameId", "world")
                put("artifact", ScanBundle.artifactRef(sessionId, "plane-set", set))
                putJsonObject("metadata") {
                    put("source", "arcore")
                    put("count", planes.size)
                }
            }
        }

        streams += buildJsonObject {
            put("id", "device-capabilities")
            put("kind", "device-capabilities")
            put("role", "capabilities")
            put("availability", "ready")
            putJsonObject("inline") {
                put("probedAt", input.capabilitiesProbedAtMs)
                put("browser", JsonNull)
                put("native", input.nativeCapabilities)
            }
        }

        val manifest = buildJsonObject {
            put("schemaVersion", 2)
            put("sessionId", sessionId)
            input.projectId?.let { put("projectId", it) }
            put("state", "ready")
            putJsonArray("clocks") {
                addJsonObject {
                    put("id", "device")
                    put("timebase", "nanoseconds")
                }
                addJsonObject {
                    put("id", "wall")
                    put("timebase", "milliseconds")
                    put("epoch", "unix")
                }
            }
            putJsonArray("coordinateFrames") {
                addJsonObject {
                    put("id", "world")
                    put("convention", ScanBundle.COORDINATE_SYSTEM)
                }
            }
            put("streams", JsonArray(streams))
            putJsonObject("metadata") {
                put("provider", ScanBundle.PROVIDER)
                put("appVersion", input.appVersion)
                put("bridgeVersion", BridgeProtocol.VERSION)
                putJsonObject("device") {
                    put("manufacturer", input.device.manufacturer)
                    put("model", input.device.model)
                    put("os", input.device.os)
                }
                put("createdAt", JsonUtil.isoUtc(input.createdAtMs))
                put("trackingLossCount", input.trackingLossCount)
                put("warnings", JsonArray(warnings.map(::JsonPrimitive)))
                input.startTimestampNs?.let { put("startTimestampNs", it) }
                // Keyframe poses are Camera.getPose(): OpenGL camera axes (+X right, +Y up, -Z forward)
                // relative to the image readout, so they match the unrotated JPEG and its intrinsics.
                putJsonObject("camera") {
                    put("convention", "opengl")
                    put("frame", "image-readout")
                    put("sensorOrientationDeg", input.sensorOrientationDeg)
                }
                put("arcore", input.arcore)
            }
        }

        val manifestBytes = JsonUtil.encode(manifest).toByteArray(Charsets.UTF_8)
        check(manifestBytes.size <= ScanBundle.MAX_ARTIFACT_BYTES) { "Manifest exceeds 16 MB" }
        JsonUtil.writeAtomically(File(dir, ScanBundle.MANIFEST_FILE), manifestBytes)
        val manifestFile = ArtifactFile(
            ScanBundle.MANIFEST_FILE,
            Hashing.sha256Hex(manifestBytes),
            manifestBytes.size.toLong(),
            ScanBundle.MEDIA_JSON,
        )
        val bundle = FinalizedBundle(manifestFile, artifacts)
        UploadPlanFile.write(File(dir, ScanBundle.UPLOAD_PLAN_FILE), bundle)
        return bundle
    }
}

/** The list of files `scan.upload` sends, manifest last. Stored next to the bundle. */
object UploadPlanFile {
    fun write(file: File, bundle: FinalizedBundle) {
        val json = buildJsonObject {
            put("manifest", entry(bundle.manifest))
            put("artifacts", JsonArray(bundle.artifacts.map(::entry)))
        }
        JsonUtil.writeAtomically(file, JsonUtil.encode(json).toByteArray(Charsets.UTF_8))
    }

    fun read(file: File): FinalizedBundle {
        val obj = JsonUtil.json.parseToJsonElement(file.readText()) as JsonObject
        val manifest = parse(obj.getValue("manifest") as JsonObject)
        val artifacts = (obj.getValue("artifacts") as JsonArray).map { parse(it as JsonObject) }
        return FinalizedBundle(manifest, artifacts)
    }

    private fun entry(file: ArtifactFile) = buildJsonObject {
        put("path", file.path)
        put("sha256", file.sha256)
        put("byteLength", file.byteLength)
        put("mediaType", file.mediaType)
    }

    private fun parse(obj: JsonObject): ArtifactFile {
        fun str(key: String) = (obj.getValue(key) as JsonPrimitive).content
        return ArtifactFile(str("path"), str("sha256"), str("byteLength").toLong(), str("mediaType"))
    }
}
