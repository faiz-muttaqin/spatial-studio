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
    /** v1.1 sensor streams; null when the sensors were off for the whole scan. */
    val sensors: SensorCapture? = null,
    val lightEstimates: List<LightRecord> = emptyList(),
    /** Acquisition filter recorded with the point cloud. */
    val pointMaxDistanceM: Double? = null,
    /** v1.2 assisted boundary marks; empty when none were made, which writes no stream. */
    val boundaryMarks: List<BoundaryMark> = emptyList(),
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

    /** Rounds for JSON; an angle that rounds up to 360 becomes 0 so it stays in [0, 360). */
    private fun bearing(deg: Double): JsonPrimitive {
        val v = JsonUtil.rounded(deg, 2)
        return if (v.content.toDouble() >= 360.0) JsonPrimitive(0.0) else v
    }

    private fun nullable(value: Double?, decimals: Int): JsonElement = value?.let { JsonUtil.rounded(it, decimals) } ?: JsonNull

    private fun vector(values: DoubleArray?, decimals: Int): JsonElement =
        values?.let { v -> JsonArray(v.map { JsonUtil.rounded(it, decimals) }) } ?: JsonNull

    fun deviceOrientation(samples: List<DeviceOrientationData>): JsonObject = buildJsonObject {
        putJsonArray("samples") {
            for (s in samples) {
                addJsonObject {
                    put("timestamp", s.timestampNs)
                    put("q", vector(doubleArrayOf(s.q.x, s.q.y, s.q.z, s.q.w), 6))
                    put("headingAccuracyDeg", nullable(s.headingAccuracyDeg, 1))
                }
            }
        }
    }

    fun heading(samples: List<HeadingData>): JsonObject = buildJsonObject {
        putJsonArray("samples") {
            for (s in samples) {
                addJsonObject {
                    put("timestamp", s.timestampNs)
                    put("azimuthMagneticDeg", bearing(s.azimuthMagneticDeg))
                    put("azimuthTrueDeg", s.azimuthTrueDeg?.let(::bearing) ?: JsonNull)
                    put("declinationDeg", nullable(s.declinationDeg, 2))
                    put("magnetometerAccuracy", s.magnetometerAccuracy)
                    put("headingAccuracyDeg", nullable(s.headingAccuracyDeg, 1))
                    put("worldBearingDeg", bearing(s.worldBearingDeg))
                }
            }
        }
    }

    fun geolocation(fixes: List<LocationFix>): JsonObject = buildJsonObject {
        putJsonArray("fixes") {
            for (f in fixes) {
                addJsonObject {
                    put("timestamp", f.timestampMs)
                    put("latitude", JsonUtil.rounded(f.latitude, 5))
                    put("longitude", JsonUtil.rounded(f.longitude, 5))
                    put("altitudeM", nullable(f.altitudeM, 1))
                    put("accuracyM", JsonUtil.rounded(f.accuracyM, 1))
                    put("provider", f.provider)
                }
            }
        }
    }

    fun lightEstimates(records: List<LightRecord>): JsonObject = buildJsonObject {
        putJsonArray("estimates") {
            for (r in records) {
                addJsonObject {
                    put("keyframeId", r.keyframeId)
                    put("timestamp", r.timestampNs)
                    put("mode", r.mode)
                    put("state", if (r.valid) "valid" else "invalid")
                    put("pixelIntensity", nullable(r.pixelIntensity, 4))
                    put("colorCorrection", vector(r.colorCorrection, 4))
                    put("mainLightDirection", vector(r.mainLightDirection, 6))
                    put("mainLightIntensity", vector(r.mainLightIntensity, 4))
                }
            }
        }
    }

    fun barometer(samples: List<PressureSample>): JsonObject = buildJsonObject {
        putJsonArray("samples") {
            for (s in samples) {
                addJsonObject {
                    put("timestamp", s.timestampNs)
                    put("hPa", JsonUtil.rounded(s.hPa, 3))
                }
            }
        }
    }

    private fun basePoint(point: BasePoint): JsonObject = buildJsonObject {
        putJsonArray("point") {
            add(JsonUtil.rounded(point.x.toDouble(), 6))
            add(JsonUtil.rounded(point.y.toDouble(), 6))
            add(JsonUtil.rounded(point.z.toDouble(), 6))
        }
        put("pose", JsonUtil.matrix(point.pose))
        put("planeId", point.planeId)
        put("timestamp", point.timestampNs)
    }

    /** `boundary-marks` payload (v1.2). The point is the pose translation, rounded the same way as the pose. */
    fun boundaryMarks(marks: List<BoundaryMark>): JsonObject = buildJsonObject {
        putJsonArray("marks") {
            for (m in marks) {
                addJsonObject {
                    put("id", m.id)
                    put("kind", m.kind.wire)
                    putJsonArray("base") {
                        add(basePoint(m.start))
                        add(basePoint(m.end))
                    }
                    putJsonObject("height") {
                        put("metres", nullable(m.height.metres, 3))
                        put("source", m.height.source.wire)
                        put("ceilingPlaneId", m.height.ceilingPlaneId)
                    }
                    put("source", "manual-ar-marking")
                    put("createdAt", m.createdAtMs)
                    put("notes", JsonNull)
                }
            }
        }
    }

    fun trueNorth(result: TrueNorthResult): JsonObject = buildJsonObject {
        // (-180, 180]: a value that rounds to -180 is the same direction as +180.
        val yaw = JsonUtil.rounded(result.worldYawDeg, 2).content.toDouble().let { if (it <= -180.0) 180.0 else it }
        put("worldYawDeg", yaw)
        put("confidence", JsonUtil.rounded(result.confidence.coerceIn(0.0, 1.0), 3))
        put("method", result.method)
        put("reference", result.reference)
        put("spreadDeg", JsonUtil.rounded(result.spreadDeg, 2))
        put("sampleCount", result.sampleCount)
        put("declinationDeg", nullable(result.declinationDeg, 2))
        put("segmentsAgree", result.segmentsAgree)
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
                    input.pointMaxDistanceM?.let { put("maxDistanceFromCameraM", it) }
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

        val sensors = input.sensors
        var trueNorth: TrueNorthResult? = null
        if (sensors != null) {
            warnings += sensors.warnings
            val streamMeta = { count: Int ->
                buildJsonObject {
                    put("source", "rotation-vector")
                    put("timestampSource", sensors.timestampSource)
                    put("count", count)
                }
            }
            fun jsonStream(id: String, role: String, clock: String, frame: String?, file: ArtifactFile, meta: JsonObject) = buildJsonObject {
                put("id", id)
                put("kind", id)
                put("role", role)
                put("availability", "ready")
                frame?.let { put("frameId", it) }
                put("clockId", clock)
                put("artifact", ScanBundle.artifactRef(sessionId, id, file))
                put("metadata", meta)
            }
            if (sensors.orientation.isNotEmpty()) {
                val file = writeJson("device-orientation.json", ScanBundle.deviceOrientation(sensors.orientation))
                streams += jsonStream("device-orientation", "orientation", "device", null, file, streamMeta(sensors.orientation.size))
            }
            if (sensors.heading.isNotEmpty()) {
                val file = writeJson("heading.json", ScanBundle.heading(sensors.heading))
                streams += jsonStream("heading", "heading", "device", null, file, streamMeta(sensors.heading.size))
                trueNorth = NorthEstimator.estimate(sensors.heading)
            }
            if (sensors.fixes.isNotEmpty()) {
                val file = writeJson("geolocation.json", ScanBundle.geolocation(sensors.fixes))
                streams += jsonStream(
                    "geolocation", "geolocation", "wall", null, file,
                    buildJsonObject {
                        put("source", "location-manager")
                        put("count", sensors.fixes.size)
                    },
                )
            }
            if (sensors.pressure.isNotEmpty()) {
                val file = writeJson("barometer.json", ScanBundle.barometer(sensors.pressure))
                streams += jsonStream(
                    "barometer", "barometer", "device", null, file,
                    buildJsonObject {
                        put("source", "pressure-sensor")
                        put("count", sensors.pressure.size)
                    },
                )
            }
        }
        val lightRecords = input.lightEstimates.filter { it.keyframeId in keyframeIds }
        if (lightRecords.isNotEmpty()) {
            val file = writeJson("light-estimate.json", ScanBundle.lightEstimates(lightRecords))
            streams += buildJsonObject {
                put("id", "light-estimate")
                put("kind", "light-estimate")
                put("role", "lightEstimate")
                put("availability", "ready")
                put("frameId", "world")
                put("clockId", "device")
                put("artifact", ScanBundle.artifactRef(sessionId, "light-estimate", file))
                putJsonObject("metadata") {
                    put("source", "arcore")
                    put("mode", lightRecords.first().mode)
                    put("count", lightRecords.size)
                }
            }
        }

        // Marks reference planes by id; a mark with a non-finite pose cannot be written as JSON and is dropped.
        val marks = input.boundaryMarks.filter { m ->
            PoseMath.isFinite(m.start.pose) && PoseMath.isFinite(m.end.pose)
        }
        if (marks.size < input.boundaryMarks.size) warnings += "boundary-mark-invalid"
        if (marks.isNotEmpty()) {
            val file = writeJson("boundary-marks.json", ScanBundle.boundaryMarks(marks))
            streams += buildJsonObject {
                put("id", "boundary-marks")
                put("kind", "boundary-marks")
                put("role", "boundaryMarks")
                put("availability", "ready")
                put("frameId", "world")
                put("artifact", ScanBundle.artifactRef(sessionId, "boundary-marks", file))
                putJsonObject("metadata") {
                    put("source", "manual-ar-marking")
                    put("count", marks.size)
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
                trueNorth?.let { put("trueNorth", ScanBundle.trueNorth(it)) }
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
