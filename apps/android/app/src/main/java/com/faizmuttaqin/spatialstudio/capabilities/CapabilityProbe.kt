package com.faizmuttaqin.spatialstudio.capabilities

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import androidx.webkit.WebViewCompat
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Session
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

/** The `capabilities.get` result. Reads hardware facts; never opens the camera stream. */
class CapabilityProbe(private val context: Context) {

    private class DepthSupport(val depth: Boolean, val rawDepth: Boolean, val probe: String)

    /**
     * @param session an ARCore session the caller already owns (the scan screen); when null a
     *   short-lived session is created to ask about depth, if that is possible right now.
     * @param scanActive true while the scan screen owns ARCore, so no second session is created.
     */
    fun probe(session: Session? = null, scanActive: Boolean = false): JsonObject {
        val availability = arcoreAvailability(waitForResult = session == null)
        val depth = when {
            session != null -> depthFrom(session).also { cachedDepth = it }
            scanActive -> cachedDepth ?: DepthSupport(false, false, "scan_active")
            else -> probeDepth(availability)
        }
        return buildJsonObject {
            putJsonObject("arcore") {
                put("availability", availability.name.lowercase())
                put("depth", depth.depth)
                put("rawDepth", depth.rawDepth)
                put("depthProbe", depth.probe)
            }
            put("cameras", cameras())
            val sensors = sensors()
            put("sensors", JsonObject(sensors.mapValues { JsonPrimitive(it.value != null) }))
            put("sensorDetails", JsonObject(sensors.filterValues { it != null }.mapValues { it.value!! }))
            putJsonObject("device") {
                put("manufacturer", Build.MANUFACTURER)
                put("model", Build.MODEL)
                put("sdkInt", Build.VERSION.SDK_INT)
                put("release", Build.VERSION.RELEASE)
                val webView = WebViewCompat.getCurrentWebViewPackage(context)
                put("webViewVersion", webView?.versionName)
                put("webViewPackage", webView?.packageName)
            }
        }
    }

    private fun arcoreAvailability(waitForResult: Boolean): ArCoreApk.Availability {
        var availability = ArCoreApk.getInstance().checkAvailability(context)
        if (!waitForResult) return availability
        // The first query can be transient while ARCore asks its service; poll briefly.
        var waitedMs = 0
        while (availability.isTransient && waitedMs < 2_000) {
            Thread.sleep(200)
            waitedMs += 200
            availability = ArCoreApk.getInstance().checkAvailability(context)
        }
        return availability
    }

    private fun probeDepth(availability: ArCoreApk.Availability): DepthSupport {
        cachedDepth?.let { return it }
        if (availability != ArCoreApk.Availability.SUPPORTED_INSTALLED) {
            val reason = when {
                availability.isUnsupported -> "unsupported"
                availability.isUnknown -> "unknown"
                else -> "not_installed"
            }
            return DepthSupport(false, false, reason)
        }
        // ARCore requires the camera permission to create a session.
        if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return DepthSupport(false, false, "needs_camera_permission")
        }
        return try {
            val session = Session(context)
            try {
                depthFrom(session).also { cachedDepth = it }
            } finally {
                session.close()
            }
        } catch (e: Exception) {
            DepthSupport(false, false, "failed")
        }
    }

    private fun depthFrom(session: Session) = DepthSupport(
        depth = session.isDepthModeSupported(Config.DepthMode.AUTOMATIC),
        rawDepth = session.isDepthModeSupported(Config.DepthMode.RAW_DEPTH_ONLY),
        probe = "ok",
    )

    private fun cameras(): JsonArray {
        val manager = context.getSystemService(CameraManager::class.java) ?: return JsonArray(emptyList())
        val ids = runCatching { manager.cameraIdList.toList() }.getOrDefault(emptyList())
        return buildJsonArray {
            for (id in ids) {
                val c = runCatching { manager.getCameraCharacteristics(id) }.getOrNull() ?: continue
                addJsonObject { describeCamera(id, c) }
            }
        }
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.describeCamera(id: String, c: CameraCharacteristics) {
        put("id", id)
        put(
            "facing",
            when (c.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
                else -> "unknown"
            },
        )
        putJsonArray("focalLengths") {
            c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.forEach { add(it.toDouble()) }
        }
        val calibration = c.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION)
        val reference = c.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
        // Devices without calibration report zeros; that is "unknown", not a zero focal length.
        val intrinsics: JsonElement = if (calibration != null && calibration.size >= 5 && calibration[0] > 0f && calibration[1] > 0f) {
            buildJsonObject {
                put("fx", calibration[0].toDouble())
                put("fy", calibration[1].toDouble())
                put("cx", calibration[2].toDouble())
                put("cy", calibration[3].toDouble())
                put("skew", calibration[4].toDouble())
                if (reference != null) {
                    put("referenceWidth", reference.width())
                    put("referenceHeight", reference.height())
                }
            }
        } else {
            JsonNull
        }
        put("intrinsics", intrinsics)
        val distortion = if (Build.VERSION.SDK_INT >= 28) {
            c.get(CameraCharacteristics.LENS_DISTORTION)
        } else {
            @Suppress("DEPRECATION")
            c.get(CameraCharacteristics.LENS_RADIAL_DISTORTION)
        }
        put("distortion", distortion?.let { values -> JsonArray(values.map { JsonPrimitive(it.toDouble()) }) } ?: JsonNull)
        val capabilities = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)?.toSet().orEmpty()
        put("depthOutput", CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT in capabilities)
        val logical = Build.VERSION.SDK_INT >= 28 &&
            CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA in capabilities
        put("logicalMultiCamera", logical)
        putJsonArray("physicalIds") {
            if (Build.VERSION.SDK_INT >= 28) c.physicalCameraIds.sorted().forEach { add(it) }
        }
        c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)?.let { size ->
            putJsonArray("sensorSizeMm") {
                add(size.width.toDouble())
                add(size.height.toDouble())
            }
        }
        c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)?.let { size ->
            putJsonArray("pixelArraySize") {
                add(size.width)
                add(size.height)
            }
        }
        put(
            "hardwareLevel",
            when (c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
                CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "legacy"
                CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "limited"
                CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "full"
                CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "level_3"
                CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "external"
                else -> "unknown"
            },
        )
    }

    /** Sensor key to details, or null when the device has no such sensor. */
    private fun sensors(): Map<String, JsonObject?> {
        val manager = context.getSystemService(SensorManager::class.java)
        return SENSOR_TYPES.mapValues { (_, type) ->
            manager?.getDefaultSensor(type)?.let { sensor ->
                buildJsonObject {
                    put("name", sensor.name)
                    put("vendor", sensor.vendor)
                    put("resolution", sensor.resolution.toDouble())
                    put("maxRange", sensor.maximumRange.toDouble())
                    put("minDelayUs", sensor.minDelay)
                }
            }
        }
    }

    companion object {
        @Volatile
        private var cachedDepth: DepthSupport? = null

        private val SENSOR_TYPES = linkedMapOf(
            "accelerometer" to Sensor.TYPE_ACCELEROMETER,
            "gyroscope" to Sensor.TYPE_GYROSCOPE,
            "rotationVector" to Sensor.TYPE_ROTATION_VECTOR,
            "gameRotationVector" to Sensor.TYPE_GAME_ROTATION_VECTOR,
            "magnetometer" to Sensor.TYPE_MAGNETIC_FIELD,
            "barometer" to Sensor.TYPE_PRESSURE,
            "gravity" to Sensor.TYPE_GRAVITY,
            "linearAcceleration" to Sensor.TYPE_LINEAR_ACCELERATION,
            "light" to Sensor.TYPE_LIGHT,
            "proximity" to Sensor.TYPE_PROXIMITY,
        )
    }
}
