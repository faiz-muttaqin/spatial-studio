package com.faizmuttaqin.spatialstudio.scan

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log

class DeviceOrientationData(val timestampNs: Long, val q: Quaternion, val headingAccuracyDeg: Double?)

class PressureSample(val timestampNs: Long, val hPa: Double)

class LocationFix(
    val timestampMs: Long,
    val latitude: Double,
    val longitude: Double,
    val altitudeM: Double?,
    val accuracyM: Double,
    /** `gps`, `network`, `fused`, `passive` or `unknown`. */
    val provider: String,
)

/** Everything the sensor streams need, taken after [SensorRecorder.stop]. */
class SensorCapture(
    val orientation: List<DeviceOrientationData>,
    val heading: List<HeadingData>,
    val fixes: List<LocationFix>,
    val pressure: List<PressureSample>,
    /** `realtime` when sensor and camera timestamps share a clock, else `unknown`. */
    val timestampSource: String,
    val warnings: List<String>,
    /** Heading frame counts by outcome and the clock states, for explaining an empty or weak heading stream. */
    val diagnostics: String = "",
    /** How frame timestamps were mapped onto the sensor clock for pairing (contract v1.3). */
    val frameClock: FrameClockReport? = null,
)

/** The frame-to-sensor clock estimate of a scan, kept in `metadata.arcore.frameClock`. */
class FrameClockReport(
    val method: String,
    /** The offset in force at the end of the scan, and its extremes. */
    val offsetNs: Long,
    val minOffsetNs: Long,
    val maxOffsetNs: Long,
    val frames: Int,
    /** The 10th, 50th and 90th percentile of delivery delta at the last refresh, so a base shift can be told from latency offline. */
    val deltaP10Ns: Long,
    val deltaP50Ns: Long,
    val deltaP90Ns: Long,
)

/**
 * Records orientation, compass heading, barometer and (opt-in) location with platform APIs only.
 * Listeners exist only between [start] and [stop], so nothing runs while the scan screen is paused.
 * Every series is bounded; hitting a bound adds a `<kind>-truncated` warning.
 */
class SensorRecorder(
    context: Context,
    sensors: Boolean,
    location: Boolean,
) {
    private val appContext = context.applicationContext
    private val sensorManager = appContext.getSystemService(SensorManager::class.java)
    private val locationManager = appContext.getSystemService(LocationManager::class.java)

    private val orientation = BoundedSeries<DeviceOrientationData>(MAX_ORIENTATION, ORIENTATION_MIN_INTERVAL_NS)
    private val heading = BoundedSeries<HeadingData>(MAX_HEADING, HEADING_MIN_INTERVAL_NS)
    private val pressure = BoundedSeries<PressureSample>(MAX_PRESSURE, PRESSURE_MIN_INTERVAL_NS)
    private val fixes = BoundedSeries<LocationFix>(MAX_FIXES, FIX_MIN_INTERVAL_MS)

    @Volatile private var sensorsOn = sensors
    @Volatile private var locationOn = location
    @Volatile private var running = false

    private val history = OrientationHistory()
    private val diagnostics = HeadingDiagnostics()
    @Volatile private var magnetometerAccuracy = 0
    // The frame clock is estimated continuously against the sensors' boot clock; headings pair through the offset.
    private val frameClock = FrameClockEstimator()
    private val sensorClock = ClockCalibrator()

    /**
     * False in the ready state before recording: sensors run (history and clocks warm up) but no series keeps a
     * sample. [beginRecording] clears the series and starts keeping them.
     */
    @Volatile private var recording = false

    /** Most recent camera-direction reading for the HUD; null until the phone is held upright. */
    @Volatile var live: HeadingData? = null
        private set

    @Volatile var hasRotationVector = true
        private set

    @Volatile var hasPressure = false
        private set

    val fixCount: Int get() = fixes.size

    private var thread: HandlerThread? = null
    private var sensorsRegistered = false
    private var locationRegistered = false

    val sensorsEnabled: Boolean get() = sensorsOn
    val locationEnabled: Boolean get() = locationOn

    fun hasLocationPermission(): Boolean =
        appContext.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Main thread. Registers the listeners that are enabled. */
    fun start() {
        if (running) return
        running = true
        thread = HandlerThread("scan-sensors").also { it.start() }
        applyRegistrations()
    }

    /** Main thread. Starts keeping samples; anything gathered while only getting ready is dropped. */
    fun beginRecording() {
        orientation.clear()
        heading.clear()
        pressure.clear()
        diagnostics.clear()
        fixes.clear()
        recording = true
        // A very recent last-known fix (the place, for the declination) is offered again, now that fixes are kept.
        if (locationOn && locationRegistered) offerLastKnown()
    }

    /**
     * The ARCore session was reconfigured: the frame clock's base may have moved. The estimate starts again, and
     * [clockReady] says when pairing can be trusted. Safe from the GL thread.
     */
    fun resetFrameClock() = frameClock.reset()

    /** True when headings would pair correctly now: sensors off (nothing to pair) or the frame clock estimated. */
    val clockReady: Boolean get() = !sensorsOn || frameClock.ready

    /** Main thread. Closes every listener and the sensor thread. */
    fun stop() {
        if (!running) return
        running = false
        unregisterSensors()
        unregisterLocation()
        thread?.quitSafely()
        thread = null
    }

    /** Off clears what was recorded for these streams: off means nothing is saved. */
    fun setSensorsEnabled(enabled: Boolean) {
        if (sensorsOn == enabled) return
        sensorsOn = enabled
        if (!enabled) {
            orientation.clear()
            heading.clear()
            pressure.clear()
            history.clear()
            diagnostics.clear()
            live = null
        }
        if (running) applyRegistrations()
    }

    /** Off clears the recorded fixes and the declination derived from them. */
    fun setLocationEnabled(enabled: Boolean) {
        if (locationOn == enabled) return
        locationOn = enabled
        if (!enabled) {
            fixes.clear()
        }
        if (running) applyRegistrations()
    }

    private fun applyRegistrations() {
        if (sensorsOn) registerSensors() else unregisterSensors()
        if (locationOn && hasLocationPermission()) registerLocation() else unregisterLocation()
    }

    /**
     * GL thread, once per tracked frame. Headings are paired and stored only once both the ARCore frame
     * clock and the sensor clock have been verified against the boot-time clock.
     */
    fun onFrame(frameTimestampNs: Long, pose: FloatArray, elapsedNs: Long = SystemClock.elapsedRealtimeNanos()) {
        if (!sensorsOn) return
        frameClock.add(frameTimestampNs, elapsedNs)
        if (!frameClock.ready || sensorClock.state != ClockCalibrator.State.COMPARABLE) return
        if (!recording || !heading.accepts(frameTimestampNs)) return
        // The reading nearest the frame's capture time, not the newest: the camera image is older than the latest sensor event.
        // After an adopted clock shift the frame time is mapped back onto the clock the sensors share.
        val pairingNs = frameTimestampNs + frameClock.offsetNs
        val reading = history.nearest(pairingNs)
        diagnostics.count("frames")
        if (reading == null) {
            diagnostics.count("no-orientation")
            return
        }
        // Magnetic only: the declination comes from retained fixes at finalisation, so switching location off removes it.
        val paired = HeadingMath.sample(
            frameTimestampNs = pairingNs,
            pose = pose,
            orientation = reading,
            magnetometerAccuracy = magnetometerAccuracy,
            declinationDeg = null,
            maxAgeNs = MAX_PAIR_AGE_NS,
        )
        if (paired == null) {
            diagnostics.count(HeadingMath.diagnose(pairingNs, pose, reading, MAX_PAIR_AGE_NS))
            return
        }
        // The stored sample keeps the frame's own timestamp, the one keyframes and the trajectory use.
        val sample = HeadingData(
            frameTimestampNs, paired.azimuthMagneticDeg, paired.azimuthTrueDeg, paired.declinationDeg,
            paired.magnetometerAccuracy, paired.headingAccuracyDeg, paired.worldBearingDeg,
        )
        diagnostics.count("paired")
        live = sample
        heading.offerIf(frameTimestampNs, sample) { sensorsOn }
    }

    /** Both clocks on the boot clock throughout, so sensor and camera timestamps can be compared directly. */
    val clocksVerified: Boolean
        get() = frameClock.ready && !frameClock.offsetApplied && sensorClock.state == ClockCalibrator.State.COMPARABLE

    private val clockMismatch: Boolean
        get() = sensorClock.state == ClockCalibrator.State.MISMATCH

    fun captured(): SensorCapture {
        val warnings = ArrayList<String>()
        if (orientation.truncated) warnings += "device-orientation-truncated"
        if (heading.truncated) warnings += "heading-truncated"
        if (pressure.truncated) warnings += "barometer-truncated"
        if (fixes.truncated) warnings += "geolocation-truncated"
        if (sensorsOn && clockMismatch) warnings += "sensor-clock-not-comparable"
        if (sensorsOn && frameClock.offsetApplied) warnings += "frame-clock-offset-applied"
        return SensorCapture(
            orientation = orientation.snapshot(),
            heading = heading.snapshot(),
            fixes = fixes.snapshot(),
            pressure = pressure.snapshot(),
            timestampSource = if (clocksVerified) "realtime" else "unknown",
            warnings = warnings,
            diagnostics = "clocks=frame:${frameClock.method}${if (frameClock.ready) "" else "(pending)"},sensor:${sensorClock.state} ${diagnostics.summary()}".trim(),
            frameClock = if (frameClock.ready) {
                FrameClockReport(
                    frameClock.method, frameClock.offsetNs, frameClock.minOffsetNs, frameClock.maxOffsetNs, frameClock.frames,
                    frameClock.deltaP10Ns, frameClock.deltaP50Ns, frameClock.deltaP90Ns,
                )
            } else {
                null
            },
        )
    }

    // --- Motion and environment sensors ---

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            when (event.sensor.type) {
                Sensor.TYPE_ROTATION_VECTOR -> onRotationVector(event)
                Sensor.TYPE_MAGNETIC_FIELD -> magnetometerAccuracy = event.accuracy
                Sensor.TYPE_PRESSURE -> onPressure(event)
            }
        }

        override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
            if (sensor.type == Sensor.TYPE_MAGNETIC_FIELD) magnetometerAccuracy = accuracy
        }
    }

    private fun onRotationVector(event: SensorEvent) {
        val q = Quaternion.fromRotationVector(event.values) ?: return
        val accuracyRad = event.values.getOrNull(4)
        val accuracyDeg = accuracyRad?.takeIf { it.isFinite() && it >= 0f }?.let { Math.toDegrees(it.toDouble()) }
        if (!sensorsOn) return
        sensorClock.add(event.timestamp, SystemClock.elapsedRealtimeNanos())
        history.add(OrientationReading(event.timestamp, q, accuracyDeg))
        if (recording) orientation.offerIf(event.timestamp, DeviceOrientationData(event.timestamp, q, accuracyDeg)) { sensorsOn }
    }

    private fun onPressure(event: SensorEvent) {
        val hPa = event.values.firstOrNull()?.toDouble() ?: return
        if (recording && hPa.isFinite() && hPa in MIN_HPA..MAX_HPA) pressure.offerIf(event.timestamp, PressureSample(event.timestamp, hPa)) { sensorsOn }
    }

    private fun registerSensors() {
        if (sensorsRegistered) return
        val manager = sensorManager ?: return
        val handler = thread?.looper?.let { android.os.Handler(it) } ?: return
        val rotation = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        hasRotationVector = rotation != null
        rotation?.let { manager.registerListener(sensorListener, it, ROTATION_PERIOD_US, handler) }
        manager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
            ?.let { manager.registerListener(sensorListener, it, MAGNETOMETER_PERIOD_US, handler) }
        val barometer = manager.getDefaultSensor(Sensor.TYPE_PRESSURE)
        hasPressure = barometer != null
        barometer?.let { manager.registerListener(sensorListener, it, PRESSURE_PERIOD_US, handler) }
        sensorsRegistered = true
    }

    private fun unregisterSensors() {
        if (!sensorsRegistered) return
        sensorManager?.unregisterListener(sensorListener)
        sensorsRegistered = false
    }

    // --- Location (opt-in) ---

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onFix(location)

        @Deprecated("Removed in API 29 but still called on older releases.")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

        override fun onProviderEnabled(provider: String) = Unit

        override fun onProviderDisabled(provider: String) = Unit
    }

    private fun onFix(location: Location) {
        if (!recording || !locationOn || !location.hasAccuracy()) return
        val lat = location.latitude
        val lng = location.longitude
        if (!(lat.isFinite() && lng.isFinite() && lat in -90.0..90.0 && lng in -180.0..180.0)) return
        val altitude = if (location.hasAltitude()) location.altitude.takeIf { it.isFinite() } else null
        val time = location.time.takeIf { it > 0 } ?: System.currentTimeMillis()
        val fix = LocationFix(time, lat, lng, altitude, location.accuracy.toDouble(), providerName(location.provider))
        fixes.offerIf(time, fix) { locationOn }
    }

    private fun registerLocation() {
        if (locationRegistered) return
        val manager = locationManager ?: return
        val looper = thread?.looper ?: return
        val providers = buildList {
            add(LocationManager.NETWORK_PROVIDER)
            if (Build.VERSION.SDK_INT >= 31) add(LocationManager.FUSED_PROVIDER)
            add(LocationManager.PASSIVE_PROVIDER)
        }
        var any = false
        for (provider in providers) {
            try {
                if (provider != LocationManager.PASSIVE_PROVIDER && !manager.isProviderEnabled(provider)) continue
                manager.requestLocationUpdates(provider, LOCATION_INTERVAL_MS, 0f, locationListener, looper)
                any = true
            } catch (e: SecurityException) {
                Log.w(TAG, "Location provider $provider refused: permission", e)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "Location provider $provider is not available", e)
            }
        }
        locationRegistered = any
        // Only counts once recording has begun (see onFix); this covers location switched on during recording.
        if (any && recording) offerLastKnown()
    }

    /** A very recent last-known fix gives the declination at once; an old one is not the capture place. */
    private fun offerLastKnown() {
        val manager = locationManager ?: return
        val providers = buildList {
            add(LocationManager.NETWORK_PROVIDER)
            if (Build.VERSION.SDK_INT >= 31) add(LocationManager.FUSED_PROVIDER)
            add(LocationManager.PASSIVE_PROVIDER)
        }
        for (provider in providers) {
            try {
                manager.getLastKnownLocation(provider)
                    ?.takeIf { System.currentTimeMillis() - it.time <= MAX_LAST_KNOWN_AGE_MS }
                    ?.let(::onFix)
            } catch (e: SecurityException) {
                Log.w(TAG, "Last known location refused: permission", e)
            } catch (e: IllegalArgumentException) {
                // The provider is not there on this phone.
            }
        }
    }

    private fun unregisterLocation() {
        if (!locationRegistered) return
        runCatching { locationManager?.removeUpdates(locationListener) }
        locationRegistered = false
    }

    private fun providerName(raw: String?): String = when (raw) {
        LocationManager.GPS_PROVIDER -> "gps"
        LocationManager.NETWORK_PROVIDER -> "network"
        LocationManager.PASSIVE_PROVIDER -> "passive"
        "fused" -> "fused"
        else -> "unknown"
    }

    companion object {
        private const val TAG = "SensorRecorder"
        const val MAX_ORIENTATION = 36_000
        const val MAX_HEADING = 6_000
        const val MAX_PRESSURE = 4_000
        const val MAX_FIXES = 60

        // A little under the nominal period so jittery events still land on the target rate.
        private const val ORIENTATION_MIN_INTERVAL_NS = 18_000_000L // about 50 Hz
        private const val HEADING_MIN_INTERVAL_NS = 190_000_000L // about 5 Hz
        private const val PRESSURE_MIN_INTERVAL_NS = 450_000_000L // about 2 Hz
        private const val FIX_MIN_INTERVAL_MS = 10_000L
        private const val ROTATION_PERIOD_US = 20_000
        private const val MAGNETOMETER_PERIOD_US = 200_000
        private const val PRESSURE_PERIOD_US = 500_000
        private const val LOCATION_INTERVAL_MS = 10_000L
        private const val MAX_LAST_KNOWN_AGE_MS = 5 * 60 * 1000L
        // Sensors run at 50 Hz, so the nearest reading is within about 10 ms; allow a little jitter.
        private const val MAX_PAIR_AGE_NS = 40_000_000L
        private const val MIN_HPA = 300.0
        private const val MAX_HPA = 1100.0
    }
}

/** The platform's World Magnetic Model. */
object AndroidDeclination : DeclinationSource {
    override fun declination(latitude: Double, longitude: Double, altitudeM: Double, timeMs: Long): Double? =
        runCatching {
            android.hardware.GeomagneticField(latitude.toFloat(), longitude.toFloat(), altitudeM.toFloat(), timeMs).declination.toDouble()
        }.getOrNull()
}
