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

    @Volatile private var latestOrientation: OrientationReading? = null
    @Volatile private var magnetometerAccuracy = 0
    private val frameClock = ClockCalibrator()
    private val sensorClock = ClockCalibrator()

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
            latestOrientation = null
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
        if (frameClock.state != ClockCalibrator.State.COMPARABLE || sensorClock.state != ClockCalibrator.State.COMPARABLE) return
        if (!heading.accepts(frameTimestampNs)) return
        val reading = latestOrientation ?: return
        // Magnetic only: the declination comes from retained fixes at finalisation, so switching location off removes it.
        val sample = HeadingMath.sample(
            frameTimestampNs = frameTimestampNs,
            pose = pose,
            orientation = reading,
            magnetometerAccuracy = magnetometerAccuracy,
            declinationDeg = null,
            maxAgeNs = MAX_PAIR_AGE_NS,
        ) ?: return
        live = sample
        heading.offerIf(frameTimestampNs, sample) { sensorsOn }
    }

    /** Verified boot-time clocks for both sources, so sensor and camera timestamps can be compared. */
    val clocksVerified: Boolean
        get() = frameClock.state == ClockCalibrator.State.COMPARABLE && sensorClock.state == ClockCalibrator.State.COMPARABLE

    private val clockMismatch: Boolean
        get() = frameClock.state == ClockCalibrator.State.MISMATCH || sensorClock.state == ClockCalibrator.State.MISMATCH

    fun captured(): SensorCapture {
        val warnings = ArrayList<String>()
        if (orientation.truncated) warnings += "device-orientation-truncated"
        if (heading.truncated) warnings += "heading-truncated"
        if (pressure.truncated) warnings += "barometer-truncated"
        if (fixes.truncated) warnings += "geolocation-truncated"
        if (sensorsOn && clockMismatch) warnings += "sensor-clock-not-comparable"
        return SensorCapture(
            orientation = orientation.snapshot(),
            heading = heading.snapshot(),
            fixes = fixes.snapshot(),
            pressure = pressure.snapshot(),
            timestampSource = if (clocksVerified) "realtime" else "unknown",
            warnings = warnings,
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
        latestOrientation = OrientationReading(event.timestamp, q, accuracyDeg)
        orientation.offerIf(event.timestamp, DeviceOrientationData(event.timestamp, q, accuracyDeg)) { sensorsOn }
    }

    private fun onPressure(event: SensorEvent) {
        val hPa = event.values.firstOrNull()?.toDouble() ?: return
        if (hPa.isFinite() && hPa in MIN_HPA..MAX_HPA) pressure.offerIf(event.timestamp, PressureSample(event.timestamp, hPa)) { sensorsOn }
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
        if (!locationOn || !location.hasAccuracy()) return
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
                // A very recent last-known fix gives the declination at once; an old one is not the capture place.
                manager.getLastKnownLocation(provider)
                    ?.takeIf { System.currentTimeMillis() - it.time <= MAX_LAST_KNOWN_AGE_MS }
                    ?.let(::onFix)
            } catch (e: SecurityException) {
                Log.w(TAG, "Location provider $provider refused: permission", e)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "Location provider $provider is not available", e)
            }
        }
        locationRegistered = any
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
        private const val MAX_PAIR_AGE_NS = 100_000_000L
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
