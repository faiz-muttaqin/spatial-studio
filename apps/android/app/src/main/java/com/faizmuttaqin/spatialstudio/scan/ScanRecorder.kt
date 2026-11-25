package com.faizmuttaqin.spatialstudio.scan

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.util.Log
import com.faizmuttaqin.spatialstudio.live.LiveFrameType
import com.faizmuttaqin.spatialstudio.live.LiveFrames
import com.faizmuttaqin.spatialstudio.live.LiveStream
import com.google.ar.core.Camera
import com.google.ar.core.CameraIntrinsics
import com.google.ar.core.Config
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import java.io.ByteArrayOutputStream
import java.nio.ByteOrder
import java.io.File
import java.util.Collections
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Turns ARCore frames into scan data: trajectory, keyframes (JPEG, intrinsics,
 * pose), depth, accumulated point cloud and planes. [onFrame] runs on the GL
 * thread; image encoding runs on one background thread.
 */
class ScanRecorder(
    private val dir: File,
    options: ScanOptions,
    /** `raw`, `smoothed`, or null when depth is off or unsupported. */
    depthKind: String?,
) {
    val selector = KeyframeSelector(options.keyframeSpacingM, options.keyframeAngleDeg, options.maxKeyframes)
    val trajectory = TrajectoryRecorder()
    val voxels = VoxelDownsampler(minConfidence = POINT_MIN_CONFIDENCE)
    val keyframes: MutableList<KeyframeRecord> = Collections.synchronizedList(ArrayList())
    val depthFrames: MutableList<DepthRecord> = Collections.synchronizedList(ArrayList())
    val warnings: MutableSet<String> = Collections.synchronizedSet(LinkedHashSet())
    val lightEstimates: MutableList<LightRecord> = Collections.synchronizedList(ArrayList())

    // R3 live guidance. All of it runs on the GL thread; the screen reads [guidance] and [torchActive].
    private val continuity = PoseContinuity()
    private val motion = MotionGuard()
    val coverage = CoverageGrid()
    private val coverageDepthGate = IntervalGate(COVERAGE_DEPTH_INTERVAL_NS)
    private val guidanceGate = IntervalGate(GUIDANCE_INTERVAL_NS)
    private val poseJumps = Collections.synchronizedList(ArrayList<PoseJumpEvent>())
    private var jumpOpen = false
    private var lastWasFastSkip = false
    private var dueSinceNs: Long? = null
    private val resumeRequested = AtomicBoolean(false)
    @Volatile var fastKeyframeSkips = 0
        private set

    /** Set while the live preview is open (P2N.3). Read on the GL thread; frames are dropped when it is null or slow. */
    @Volatile var live: LiveStream? = null

    /** What the HUD shows about coverage and motion; replaced about four times a second. */
    @Volatile var guidance = Guidance()
        private set

    /** Torch state per keyframe. [setTorch] is called on the GL thread after ARCore accepted the configuration. */
    @Volatile var torchActive = false
        private set

    /** Null until the torch was asked for; then what `session.isSupported(config)` said. */
    @Volatile var torchSupported: Boolean? = null
        private set

    class Guidance(
        val floorPercent: Int? = null,
        val tooFast: Boolean = false,
        val jumpHeld: Boolean = false,
        val jumpStuck: Boolean = false,
        val wallSide: WallSide? = null,
    )

    class PoseJumpEvent(
        val timestampNs: Long,
        val metres: Float,
        val degrees: Float,
        var recoveredTimestampNs: Long? = null,
        var manualResume: Boolean = false,
    )

    /** The user says the pose is fine: resume recording from here. Handled on the next GL frame. */
    fun requestResume() = resumeRequested.set(true)

    /** GL thread, after ARCore accepted (or the user switched off) the torch configuration. */
    fun setTorch(active: Boolean) {
        torchActive = active
    }

    /** What `session.isSupported` said; false adds `torch-unsupported`. */
    fun torchProbed(supported: Boolean) {
        torchSupported = supported
        if (!supported) warnings.add(WARNING_TORCH_UNSUPPORTED)
    }

    fun torchConfigureFailed() {
        torchActive = false
        warnings.add(WARNING_TORCH_CONFIGURE_FAILED)
    }

    fun torchToggledMidScan() {
        if (selector.count > 0) warnings.add(WARNING_TORCH_MID_SCAN)
    }

    /** Set by the scan screen; off when the sensors toggle is off or the mode is DISABLED. */
    @Volatile
    var lightMode: Config.LightEstimationMode = Config.LightEstimationMode.DISABLED

    @Volatile
    var depthKind: String? = depthKind
        private set

    @Volatile
    var startTimestampNs: Long? = null
        private set

    @Volatile
    var planeCount: Int = 0
        private set

    /** Plane set refreshed about once a second on the GL thread; the bundle uses the last one. */
    @Volatile
    var latestPlanes: List<PlaneRecord> = emptyList()
        private set

    /** Latest frame's feature points for the overlay, packed `x, y, z, confidence`. */
    var overlayPoints = FloatArray(0)
        private set
    var overlayCount = 0
        private set

    /** Sensors toggle: off stops light estimates and drops those already taken. */
    fun setLightEnabled(enabled: Boolean, configured: Config.LightEstimationMode) {
        lightMode = if (enabled) configured else Config.LightEstimationMode.DISABLED
        if (!enabled) lightEstimates.clear()
    }

    private val encoder = Executors.newSingleThreadExecutor()
    private val pending = AtomicInteger()
    private val planeIds = HashMap<Plane, String>()
    private var lastPointCloudTimestamp = -1L
    private val planeGate = IntervalGate(1_000_000_000L)
    private val pose = FloatArray(16)
    private var stopped = false

    /** Snapshot of everything the bundle needs, taken after [stop] and [drain]. */
    class Captured(
        val trajectory: List<TrajectorySample>,
        val trackingLossCount: Int,
        val points: FloatArray,
        val voxelSizeM: Double,
        val minConfidence: Float,
        val keyframes: List<KeyframeRecord>,
        val depth: List<DepthRecord>,
        val lightEstimates: List<LightRecord>,
    )

    /** GL thread. Synchronized with [stop] and [captured] so finalizing never races a frame. */
    @Synchronized
    fun onFrame(session: Session, frame: Frame, camera: Camera) {
        if (stopped) return
        val timestamp = frame.timestamp
        if (timestamp == 0L) return
        if (startTimestampNs == null) startTimestampNs = timestamp

        val tracking = camera.trackingState == TrackingState.TRACKING
        camera.pose.toMatrix(pose, 0)
        trajectory.onFrame(timestamp, tracking, pose)
        if (!tracking) {
            overlayCount = 0
            return
        }
        // Pose-jump guard: while ARCore's pose is off the trajectory the scan was built on, nothing is
        // recorded (no keyframes, depth or points). The trajectory above keeps recording.
        val quat = QuatPose.fromMatrix(pose)
        if (resumeRequested.getAndSet(false) && continuity.isSlipped) {
            continuity.resume()
            jumpOpen = false
            poseJumps.lastOrNull { it.recoveredTimestampNs == null }?.let {
                it.recoveredTimestampNs = timestamp
                it.manualResume = true
            }
        }
        val step = continuity.step(timestamp, quat)
        trackJump(step, timestamp)
        motion.update(timestamp, quat)
        if (!step.integrates) {
            overlayCount = 0
            publishGuidance(timestamp, pose)
            return
        }
        coverage.walls.addCamera(pose[12], pose[14])

        frame.acquirePointCloud().use { cloud ->
            if (cloud.timestamp != lastPointCloudTimestamp) {
                lastPointCloudTimestamp = cloud.timestamp
                val buffer = cloud.points
                val count = buffer.remaining() / 4
                if (overlayPoints.size < count * 4) overlayPoints = FloatArray(count * 4)
                buffer.get(overlayPoints, 0, count * 4)
                overlayCount = count
                voxels.addPackedWithin(overlayPoints, count, pose[12], pose[13], pose[14], POINT_MAX_DISTANCE_M)
                for (i in 0 until count) {
                    if (overlayPoints[i * 4 + 3] >= POINT_MIN_CONFIDENCE) {
                        coverage.addPoint(overlayPoints[i * 4], overlayPoints[i * 4 + 1], overlayPoints[i * 4 + 2])
                    }
                }
            }
        }

        if (planeGate.ready(timestamp)) {
            val planes = snapshotPlanes(session)
            latestPlanes = planes
            planeCount = planes.count { it.trackingState == "tracking" && it.subsumedBy == null }
            Log.i(TAG, "planes: ${planes.size} known, $planeCount tracking")
            updateFloor(planes)
        }
        if (coverageDepthGate.ready(timestamp)) sampleCoverageDepth(frame, camera)
        publishGuidance(timestamp, pose)
        feedLive(frame, camera, timestamp)

        if (selector.limitReached) {
            warnings.add(WARNING_KEYFRAME_LIMIT)
            return
        }
        val due = selector.shouldCapture(timestamp, true, pose)
        if (!due) dueSinceNs = null else if (dueSinceNs == null) dueSinceNs = timestamp
        val decision = KeyframeGate.decide(
            due = due,
            integrates = true,
            blocked = motion.keyframesBlocked,
            encoderBusy = pending.get() >= MAX_PENDING_ENCODES,
            dueForNs = dueSinceNs?.let { timestamp - it } ?: 0L,
        )
        // One count per episode: a due keyframe held back while the camera is too fast, not one per frame.
        if (decision == KeyframeGate.Decision.SKIP_FAST && !lastWasFastSkip) fastKeyframeSkips++
        lastWasFastSkip = decision == KeyframeGate.Decision.SKIP_FAST
        if (decision == KeyframeGate.Decision.CAPTURE) {
            dueSinceNs = null
            captureKeyframe(frame, camera, timestamp)
        }
    }

    /**
     * Preview feed (pose, depth, coverage, planes) at the stream's own rates. Never touches the recording and
     * never throws: a failed frame is a dropped preview frame.
     */
    private fun feedLive(frame: Frame, camera: Camera, timestamp: Long) {
        val stream = live ?: return
        try {
            if (stream.wants(LiveFrameType.POSE, timestamp)) {
                stream.submit(LiveFrameType.POSE, timestamp, LiveFrames.pose(stream.nextSeq(), timestamp, pose, LiveFrames.TrackingCode.TRACKING))
            }
            if (stream.wants(LiveFrameType.DEPTH, timestamp)) liveDepth(stream, frame, camera, timestamp)
            if (stream.wants(LiveFrameType.COVERAGE, timestamp)) {
                val (keys, _) = coverage.cells(LiveFrames.MAX_COVERAGE_CELLS)
                val cells = LongArray(keys.size) { keys[it] }
                val percent = guidance.floorPercent ?: -1
                stream.submit(
                    LiveFrameType.COVERAGE,
                    timestamp,
                    LiveFrames.coverage(stream.nextSeq(), timestamp, coverage.cellMetres, coverage.floorY ?: LiveFrames.NO_FLOOR, percent, cells, cells.size),
                )
            }
            if (stream.wants(LiveFrameType.PLANES, timestamp)) {
                val planes = latestPlanes
                    .filter { it.trackingState == "tracking" && it.subsumedBy == null && it.centerPose.size == 16 }
                    .map { LiveFrames.PlaneInput(LiveFrames.PlaneOrientation.of(it.orientation), it.centerPose, it.extentX, it.extentZ) }
                stream.submit(LiveFrameType.PLANES, timestamp, LiveFrames.planes(stream.nextSeq(), timestamp, planes))
            }
        } catch (e: Exception) {
            Log.w(TAG, "Live preview frame dropped", e)
        }
    }

    private fun liveDepth(stream: LiveStream, frame: Frame, camera: Camera, timestamp: Long) {
        val kind = depthKind ?: return
        try {
            val packed = if (kind == DEPTH_RAW) {
                frame.acquireRawDepthImage16Bits().use { depth ->
                    frame.acquireRawDepthConfidenceImage().use { confidence -> packDepth(depth, confidence, kind, camera) }
                }
            } else {
                frame.acquireDepthImage16Bits().use { depth -> packDepth(depth, null, kind, camera) }
            } ?: return
            if (packed.width * packed.height > LiveFrames.MAX_DEPTH_PIXELS) return
            val k = packed.intrinsics
            stream.submit(
                LiveFrameType.DEPTH,
                timestamp,
                LiveFrames.depth(
                    stream.nextSeq(), timestamp, packed.width, packed.height,
                    floatArrayOf(k.fx.toFloat(), k.fy.toFloat(), k.cx.toFloat(), k.cy.toFloat()),
                    pose, packed.depth, packed.confidence,
                ),
            )
        } catch (e: NotYetAvailableException) {
            // No depth yet: the next due frame tries again.
        }
    }

    private fun trackJump(step: PoseStep, timestamp: Long) {
        when (step) {
            PoseStep.Slipped -> if (!jumpOpen) {
                jumpOpen = true
                if (poseJumps.size < MAX_POSE_JUMPS) {
                    poseJumps.add(PoseJumpEvent(timestamp, continuity.lastJumpMetres, continuity.lastJumpDegrees))
                }
                warnings.add(WARNING_POSE_JUMP)
            }
            PoseStep.Recovered -> {
                jumpOpen = false
                poseJumps.lastOrNull { it.recoveredTimestampNs == null }?.recoveredTimestampNs = timestamp
            }
            else -> Unit
        }
    }

    private fun updateFloor(planes: List<PlaneRecord>) {
        val floorY = planes
            .filter { it.orientation == "horizontal-up" && it.trackingState == "tracking" && it.subsumedBy == null && it.centerPose.size == 16 }
            .minOfOrNull { it.centerPose[13] } ?: return
        coverage.setFloor(floorY)
        coverage.setExtent(FloorExtent.cells(planes, floorY, coverage.cellMetres))
    }

    /** About four times a second, a strided sample of depth near the floor and walls. */
    private fun sampleCoverageDepth(frame: Frame, camera: Camera) {
        if (coverage.floorY == null) return
        val kind = depthKind ?: return
        try {
            val sink = FloorSampler.Sink { x, y, z -> coverage.addPoint(x, y, z) }
            if (kind == DEPTH_RAW) {
                frame.acquireRawDepthImage16Bits().use { depth ->
                    frame.acquireRawDepthConfidenceImage().use { confidence -> sampleImage(depth, confidence, camera, sink) }
                }
            } else {
                frame.acquireDepthImage16Bits().use { depth -> sampleImage(depth, null, camera, sink) }
            }
        } catch (e: Exception) {
            // No depth this frame (not yet available, or transient): coverage just waits for the next sample.
        }
    }

    private fun sampleImage(depth: Image, confidence: Image?, camera: Camera, sink: FloorSampler.Sink) {
        val k = intrinsicsFor(camera.textureIntrinsics, depth.width, depth.height) ?: return
        val dp = depth.planes[0]
        val db = dp.buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        val conf = confidence?.takeIf { it.width == depth.width && it.height == depth.height }?.planes?.get(0)
        val cb = conf?.buffer?.duplicate()
        FloorSampler.sample(
            depth.width, depth.height, k.fx, k.fy, k.cx, k.cy, pose, COVERAGE_DEPTH_STRIDE,
            depthMmAt = { x, y -> db.getShort(y * dp.rowStride + x * dp.pixelStride).toInt() and 0xFFFF },
            confidenceAt = if (cb != null && conf != null) { x, y -> cb.get(y * conf.rowStride + x * conf.pixelStride).toInt() and 0xFF } else null,
            sink = sink,
        )
    }

    private fun publishGuidance(timestamp: Long, pose: FloatArray) {
        if (!guidanceGate.ready(timestamp)) return
        val floor = coverage.floorY
        guidance = Guidance(
            floorPercent = if (floor == null || coverage.coveredCount == 0) null else Math.round(coverage.coveredShare() * 100f),
            tooFast = motion.tooFast,
            jumpHeld = continuity.isSlipped,
            jumpStuck = continuity.isStuck,
            // The camera looks along its -Z axis: world forward is minus the third matrix column.
            wallSide = coverage.walls.missingSide(-pose[8], -pose[10]),
        )
    }

    private fun captureKeyframe(frame: Frame, camera: Camera, timestamp: Long) {
        val image = try {
            frame.acquireCameraImage()
        } catch (e: NotYetAvailableException) {
            return
        } catch (e: Exception) {
            // DeadlineExceeded or ResourceExhausted: skip this frame, try the next one.
            return
        }
        val width: Int
        val height: Int
        val nv21: ByteArray
        try {
            image.use {
                width = it.width
                height = it.height
                nv21 = ImageConversion.yuv420ToNv21(width, height, it.planes[0].data(), it.planes[1].data(), it.planes[2].data())
            }
        } catch (e: OutOfMemoryError) {
            warnings.add(WARNING_OUT_OF_MEMORY)
            return
        }
        val imageIntrinsics = intrinsicsFor(camera.imageIntrinsics, width, height)
        val depth = captureDepth(frame, camera)
        val light = lightRecord(frame, timestamp)

        val keyframePose = pose.copyOf()
        val torch = torchActive
        val id = "kf-%04d".format(Locale.ROOT, selector.reserve(timestamp, keyframePose))
        pending.incrementAndGet()
        encoder.execute {
            var stored = false
            try {
                val (size, scaledIntrinsics) = writeJpeg(id, nv21, width, height, imageIntrinsics)
                val depthRecord = depth?.let { writeDepth(id, it) }
                keyframes.add(
                    KeyframeRecord(
                        id = id,
                        timestampNs = timestamp,
                        imagePath = "keyframes/$id.jpg",
                        width = size.first,
                        height = size.second,
                        intrinsics = scaledIntrinsics,
                        pose = keyframePose,
                        trackingState = "tracking",
                        torch = torch,
                    ),
                )
                depthRecord?.let(depthFrames::add)
                light?.let { lightEstimates.add(it.copy(keyframeId = id)) }
                stored = true
            } catch (e: OutOfMemoryError) {
                // Skip this keyframe; the next one gets a fresh chance.
                warnings.add(WARNING_OUT_OF_MEMORY)
            } catch (e: Exception) {
                Log.w(TAG, "Keyframe $id could not be written", e)
                warnings.add("keyframe-write-failed")
            } finally {
                if (stored) {
                    selector.commit()
                } else {
                    selector.release()
                    val depthId = "depth-${id.removePrefix("kf-")}"
                    listOf("keyframes/$id.jpg", "depth/$depthId.u16", "depth/$depthId.conf.u8").forEach { File(dir, it).delete() }
                }
                pending.decrementAndGet()
            }
        }
    }

    /** The frame's light estimate, with the keyframe id filled in once the keyframe is stored. */
    private fun lightRecord(frame: Frame, timestamp: Long): LightRecord? {
        val mode = lightMode
        if (mode == Config.LightEstimationMode.DISABLED) return null
        return try {
            LightMath.fromEstimate(frame.lightEstimate, mode == Config.LightEstimationMode.ENVIRONMENTAL_HDR, timestamp)
        } catch (e: Exception) {
            null
        }
    }

    private class CapturedDepth(
        val timestampNs: Long,
        val width: Int,
        val height: Int,
        val depth: ByteArray,
        val confidence: ByteArray?,
        val kind: String,
        val intrinsics: Intrinsics,
    )

    private fun captureDepth(frame: Frame, camera: Camera): CapturedDepth? {
        val kind = depthKind ?: return null
        return try {
            if (kind == DEPTH_RAW) {
                frame.acquireRawDepthImage16Bits().use { depth ->
                    frame.acquireRawDepthConfidenceImage().use { confidence ->
                        packDepth(depth, confidence, kind, camera)
                    }
                }
            } else {
                frame.acquireDepthImage16Bits().use { depth -> packDepth(depth, null, kind, camera) }
            }
        } catch (e: NotYetAvailableException) {
            null
        } catch (e: IllegalStateException) {
            // Raw depth not available in this configuration after all: fall back once.
            if (kind == DEPTH_RAW) {
                depthKind = DEPTH_SMOOTHED
                warnings.add("raw-depth-unavailable")
            } else {
                depthKind = null
                warnings.add("depth-unavailable")
            }
            null
        } catch (e: Exception) {
            // Transient (deadline or resource limits): this keyframe has no depth.
            null
        }
    }

    private fun packDepth(depth: Image, confidence: Image?, kind: String, camera: Camera): CapturedDepth? {
        // Depth is aligned with the camera texture, so its intrinsics are the texture's, scaled.
        val intrinsics = intrinsicsFor(camera.textureIntrinsics, depth.width, depth.height) ?: return null
        val depthBytes = ImageConversion.packUint16LittleEndian(depth.width, depth.height, depth.planes[0].data())
        val confidenceBytes = confidence?.takeIf { it.width == depth.width && it.height == depth.height }?.let {
            ImageConversion.packUint8(it.width, it.height, it.planes[0].data())
        }
        return CapturedDepth(depth.timestamp, depth.width, depth.height, depthBytes, confidenceBytes, kind, intrinsics)
    }

    private fun writeJpeg(
        id: String,
        nv21: ByteArray,
        width: Int,
        height: Int,
        intrinsics: Intrinsics?,
    ): Pair<Pair<Int, Int>, Intrinsics?> {
        val file = File(dir, "keyframes/$id.jpg").also { it.parentFile?.mkdirs() }
        val yuv = YuvImage(nv21, ImageFormat.NV21, width, height, null)
        val (targetWidth, targetHeight) = ImageConversion.fitLongEdge(width, height, MAX_LONG_EDGE)
        if (targetWidth == width && targetHeight == height) {
            file.outputStream().use { yuv.compressToJpeg(Rect(0, 0, width, height), JPEG_QUALITY, it) }
            return (width to height) to intrinsics
        }
        val full = ByteArrayOutputStream()
        yuv.compressToJpeg(Rect(0, 0, width, height), 95, full)
        // Decode at a power-of-two reduction that is still at least the target size, then scale exactly.
        val options = BitmapFactory.Options().apply {
            inSampleSize = ImageConversion.sampleSizeFor(width, height, targetWidth, targetHeight)
        }
        val bitmap = BitmapFactory.decodeByteArray(full.toByteArray(), 0, full.size(), options)
            ?: error("Could not decode keyframe $id")
        val scaled = Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true)
        file.outputStream().use { scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
        if (scaled !== bitmap) scaled.recycle()
        bitmap.recycle()
        val sx = targetWidth.toDouble() / width
        val sy = targetHeight.toDouble() / height
        return (targetWidth to targetHeight) to intrinsics?.scaled(sx, sy)
    }

    private fun writeDepth(keyframeId: String, depth: CapturedDepth): DepthRecord {
        val id = "depth-${keyframeId.removePrefix("kf-")}"
        val depthDir = File(dir, "depth").also { it.mkdirs() }
        File(depthDir, "$id.u16").writeBytes(depth.depth)
        val confidencePath = depth.confidence?.let {
            File(depthDir, "$id.conf.u8").writeBytes(it)
            "depth/$id.conf.u8"
        }
        return DepthRecord(
            id = id,
            rgbKeyframeId = keyframeId,
            timestampNs = depth.timestampNs,
            width = depth.width,
            height = depth.height,
            depthPath = "depth/$id.u16",
            confidencePath = confidencePath,
            kind = depth.kind,
            intrinsics = depth.intrinsics,
        )
    }

    /** Current plane set. GL thread only, while the session is running. */
    private fun snapshotPlanes(session: Session): List<PlaneRecord> =
        session.getAllTrackables(Plane::class.java)
            .filter { it.trackingState != TrackingState.STOPPED }
            .map { plane ->
                val matrix = FloatArray(16)
                plane.centerPose.toMatrix(matrix, 0)
                val polygonBuffer = plane.polygon
                val polygon = FloatArray(polygonBuffer.remaining()).also { polygonBuffer.get(it) }
                PlaneRecord(
                    id = planeId(plane),
                    orientation = when (plane.type) {
                        Plane.Type.HORIZONTAL_UPWARD_FACING -> "horizontal-up"
                        Plane.Type.HORIZONTAL_DOWNWARD_FACING -> "horizontal-down"
                        else -> "vertical"
                    },
                    centerPose = matrix,
                    extentX = plane.extentX,
                    extentZ = plane.extentZ,
                    polygon = polygon,
                    subsumedBy = plane.subsumedBy?.let(::planeId),
                    trackingState = plane.trackingState.name.lowercase(),
                )
            }

    /** No frame is processed after this returns. */
    @Synchronized
    fun stop() {
        stopped = true
    }

    /** `metadata.arcore.torch` and `metadata.arcore.motionGuard` (contract v1.3). Call after [captured]. */
    fun guardMetadata(): JsonObject = buildJsonObject {
        val stored = keyframes.toList()
        put("torch", buildJsonObject {
            // Null: the torch was never asked for, so support was never probed.
            put("supported", torchSupported)
            put("framesOn", stored.count { it.torch == true })
            put("framesOff", stored.count { it.torch == false })
        })
        put("motionGuard", buildJsonObject {
            put("maxSpeedMps", MotionGuard.MAX_SPEED_MPS)
            put("maxTurnDegPerSecond", MotionGuard.MAX_TURN_DEG_PER_SECOND)
            put("keyframeMaxSpeedMps", MotionGuard.KEYFRAME_MAX_SPEED_MPS)
            put("keyframeMaxTurnDegPerSecond", MotionGuard.KEYFRAME_MAX_TURN_DEG_PER_SECOND)
            put("keyframeMaxHoldMs", MotionGuard.KEYFRAME_MAX_HOLD_NS / 1_000_000L)
            put("fastKeyframeSkips", fastKeyframeSkips)
            putJsonArray("poseJumps") {
                synchronized(poseJumps) {
                    for (jump in poseJumps) {
                        addJsonObject {
                            put("timestampNs", jump.timestampNs)
                            put("metres", jump.metres.toDouble())
                            put("degrees", jump.degrees.toDouble())
                            put("recoveredTimestampNs", jump.recoveredTimestampNs)
                            put("manualResume", jump.manualResume)
                        }
                    }
                }
            }
        })
    }

    @Synchronized
    fun captured(): Captured {
        if (fastKeyframeSkips > 0) warnings.add(WARNING_SKIPPED_FAST)
        if (jumpOpen) warnings.add(WARNING_POSE_JUMP_UNRECOVERED)
        if (trajectory.decimated) warnings.add("trajectory-decimated")
        val keyframes = keyframes.toList().sortedBy { it.timestampNs }
        val ids = keyframes.mapTo(HashSet()) { it.id }
        return Captured(
            trajectory = trajectory.samples.toList(),
            trackingLossCount = trajectory.trackingLossCount,
            points = voxels.positions(),
            voxelSizeM = voxels.voxelSizeM,
            minConfidence = voxels.minConfidence,
            keyframes = keyframes,
            depth = depthFrames.toList().filter { it.rgbKeyframeId in ids }.sortedBy { it.timestampNs },
            lightEstimates = lightEstimates.toList().filter { it.keyframeId in ids }.sortedBy { it.timestampNs },
        )
    }

    /** Waits for queued keyframes to be written. */
    fun drain(timeoutSeconds: Long = 30): Boolean {
        encoder.shutdown()
        return encoder.awaitTermination(timeoutSeconds, TimeUnit.SECONDS)
    }

    /** Stops encoding and waits briefly so no file is written after the caller deletes the directory. */
    fun abort() {
        encoder.shutdownNow()
        encoder.awaitTermination(5, TimeUnit.SECONDS)
    }

    /** Stable id of a plane, shared with the plane-set stream. GL thread. */
    @Synchronized
    fun planeIdFor(plane: Plane): String = planeId(plane)

    private fun planeId(plane: Plane): String = planeIds.getOrPut(plane) { "plane-${planeIds.size + 1}" }

    private fun intrinsicsFor(source: CameraIntrinsics, width: Int, height: Int): Intrinsics? {
        val focal = source.focalLength
        val principal = source.principalPoint
        val dims = source.imageDimensions
        if (dims[0] <= 0 || dims[1] <= 0) return null
        val base = Intrinsics(focal[0].toDouble(), focal[1].toDouble(), principal[0].toDouble(), principal[1].toDouble())
        val scaled = base.scaled(width.toDouble() / dims[0], height.toDouble() / dims[1])
        return scaled.takeIf { it.isValid }
    }

    private fun Image.Plane.data() = PlaneData(buffer, rowStride, pixelStride)

    companion object {
        private const val TAG = "ScanRecorder"
        /** Feature points farther than this from the camera, or below this confidence, are dropped at acquisition. */
        const val POINT_MAX_DISTANCE_M = 8f
        const val POINT_MIN_CONFIDENCE = 0.5f
        const val DEPTH_RAW = "raw"
        const val DEPTH_SMOOTHED = "smoothed"
        const val WARNING_KEYFRAME_LIMIT = "keyframe-limit-reached"
        const val WARNING_OUT_OF_MEMORY = "keyframe-out-of-memory"
        const val WARNING_POSE_JUMP = "pose-jump"
        const val WARNING_POSE_JUMP_UNRECOVERED = "pose-jump-unrecovered"
        const val WARNING_SKIPPED_FAST = "keyframes-skipped-fast"
        const val WARNING_TORCH_UNSUPPORTED = "torch-unsupported"
        const val WARNING_TORCH_CONFIGURE_FAILED = "torch-configure-failed"
        const val WARNING_TORCH_MID_SCAN = "torch-toggled-mid-scan"
        private const val MAX_POSE_JUMPS = 50
        private const val COVERAGE_DEPTH_INTERVAL_NS = 250_000_000L
        private const val GUIDANCE_INTERVAL_NS = 250_000_000L
        private const val COVERAGE_DEPTH_STRIDE = 6
        private const val MAX_LONG_EDGE = 1920
        private const val JPEG_QUALITY = 90
        private const val MAX_PENDING_ENCODES = 3
    }
}
