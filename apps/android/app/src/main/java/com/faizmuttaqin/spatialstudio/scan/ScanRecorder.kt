package com.faizmuttaqin.spatialstudio.scan

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.util.Log
import com.google.ar.core.Camera
import com.google.ar.core.CameraIntrinsics
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import java.io.ByteArrayOutputStream
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
    val voxels = VoxelDownsampler()
    val keyframes: MutableList<KeyframeRecord> = Collections.synchronizedList(ArrayList())
    val depthFrames: MutableList<DepthRecord> = Collections.synchronizedList(ArrayList())
    val warnings: MutableSet<String> = Collections.synchronizedSet(LinkedHashSet())

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

    private val encoder = Executors.newSingleThreadExecutor()
    private val pending = AtomicInteger()
    private val planeIds = HashMap<Plane, String>()
    private var lastPointCloudTimestamp = -1L
    private var lastPlaneSnapshotNs = Long.MIN_VALUE
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

        frame.acquirePointCloud().use { cloud ->
            if (cloud.timestamp != lastPointCloudTimestamp) {
                lastPointCloudTimestamp = cloud.timestamp
                val buffer = cloud.points
                val count = buffer.remaining() / 4
                if (overlayPoints.size < count * 4) overlayPoints = FloatArray(count * 4)
                buffer.get(overlayPoints, 0, count * 4)
                overlayCount = count
                voxels.addPacked(overlayPoints, count)
            }
        }

        if (timestamp - lastPlaneSnapshotNs >= 1_000_000_000L) {
            lastPlaneSnapshotNs = timestamp
            val planes = snapshotPlanes(session)
            latestPlanes = planes
            planeCount = planes.count { it.trackingState == "tracking" && it.subsumedBy == null }
        }

        if (selector.limitReached) {
            warnings.add(WARNING_KEYFRAME_LIMIT)
        } else if (pending.get() < MAX_PENDING_ENCODES && selector.shouldCapture(timestamp, true, pose)) {
            captureKeyframe(frame, camera, timestamp)
        }
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

        val keyframePose = pose.copyOf()
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
                    ),
                )
                depthRecord?.let(depthFrames::add)
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

    @Synchronized
    fun captured(): Captured {
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
        const val DEPTH_RAW = "raw"
        const val DEPTH_SMOOTHED = "smoothed"
        const val WARNING_KEYFRAME_LIMIT = "keyframe-limit-reached"
        const val WARNING_OUT_OF_MEMORY = "keyframe-out-of-memory"
        private const val MAX_LONG_EDGE = 1920
        private const val JPEG_QUALITY = 90
        private const val MAX_PENDING_ENCODES = 3
    }
}
