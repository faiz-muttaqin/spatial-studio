package com.faizmuttaqin.spatialstudio.scan

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** The v1.1 sensor streams in the written bundle (CAPTURE_CONTRACT.md "Sensor streams"). */
class SensorBundleTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val half = Math.sqrt(0.5)

    private fun headings(count: Int, declination: Double?) = List(count) { i ->
        val bearing = (i * 37.0) % 360.0
        val magnetic = Angles.wrap360(bearing - 30.0) // north is 30 degrees clockwise from world -Z
        HeadingData(
            timestampNs = 1_000_000_000L + i * 200_000_000L,
            azimuthMagneticDeg = magnetic,
            azimuthTrueDeg = declination?.let { Angles.wrap360(magnetic + it) },
            declinationDeg = declination,
            magnetometerAccuracy = 3,
            headingAccuracyDeg = if (i % 2 == 0) 8.0 else null,
            worldBearingDeg = Angles.wrap360(bearing + (declination ?: 0.0)),
        )
    }

    private fun capture(declination: Double?, withFix: Boolean = declination != null, warnings: List<String> = emptyList()) = SensorCapture(
        orientation = listOf(
            DeviceOrientationData(1_000_000_000L, Quaternion(0.0, 0.0, 0.0, 1.0), null),
            DeviceOrientationData(1_020_000_000L, Quaternion(half, 0.0, 0.0, half), 12.34),
        ),
        heading = headings(60, declination),
        fixes = if (withFix) listOf(LocationFix(1_764_057_700_000L, 1.352083, 103.819836, null, 850.0, "network")) else emptyList(),
        pressure = listOf(PressureSample(1_000_000_000L, 1008.1234), PressureSample(1_500_000_000L, 1008.2)),
        timestampSource = "realtime",
        warnings = warnings,
    )

    private fun light(id: String) = LightRecord(id, 1_000_000_000L, "environmental-hdr", true, null, null, doubleArrayOf(0.0, 1.0, 0.0), doubleArrayOf(3.0, 2.9, 2.5))

    private fun manifest(sensors: SensorCapture?, lights: List<LightRecord> = emptyList()): JsonObject {
        val dir = tmp.newFolder()
        ScanBundleWriter(dir).finalize(TestBundles.write(dir, sensors = sensors, lightEstimates = lights))
        System.getenv("SENSOR_BUNDLE_FIXTURE_DIR")?.let { out -> dir.copyRecursively(File(out, if (sensors?.fixes.isNullOrEmpty()) "magnetic" else "true"), overwrite = true) }
        return Json.parseToJsonElement(File(dir, "manifest.json").readText()).jsonObject
    }

    private fun streams(m: JsonObject) = m.getValue("streams").jsonArray.map { it.jsonObject }.associateBy { it.getValue("kind").jsonPrimitive.content }

    @Test
    fun withoutSensorsThereAreNoSensorStreamsOrTrueNorth() {
        val m = manifest(null)
        val kinds = streams(m).keys
        assertFalse(kinds.any { it in setOf("device-orientation", "heading", "geolocation", "barometer", "light-estimate") })
        assertFalse(m.getValue("metadata").jsonObject.containsKey("trueNorth"))
    }

    @Test
    fun writesEverySensorStreamWithContractRolesAndClocks() {
        val m = manifest(capture(declination = 1.5), listOf(light("kf-0001"), light("kf-0002")))
        val s = streams(m)
        assertEquals("orientation", s.getValue("device-orientation").getValue("role").jsonPrimitive.content)
        assertEquals("heading", s.getValue("heading").getValue("role").jsonPrimitive.content)
        assertEquals("geolocation", s.getValue("geolocation").getValue("role").jsonPrimitive.content)
        assertEquals("barometer", s.getValue("barometer").getValue("role").jsonPrimitive.content)
        assertEquals("lightEstimate", s.getValue("light-estimate").getValue("role").jsonPrimitive.content)
        assertEquals("wall", s.getValue("geolocation").getValue("clockId").jsonPrimitive.content)
        for (kind in listOf("device-orientation", "heading", "barometer", "light-estimate")) {
            assertEquals(kind, "device", s.getValue(kind).getValue("clockId").jsonPrimitive.content)
        }
        val meta = s.getValue("device-orientation").getValue("metadata").jsonObject
        assertEquals("rotation-vector", meta.getValue("source").jsonPrimitive.content)
        assertEquals("realtime", meta.getValue("timestampSource").jsonPrimitive.content)
        assertEquals(s.size, s.values.map { it.getValue("id").jsonPrimitive.content }.toSet().size)
    }

    @Test
    fun lightEstimatesOfMissingKeyframesAreLeftOut() {
        val m = manifest(null, listOf(light("kf-0001"), light("kf-9999")))
        assertEquals(1, streams(m).getValue("light-estimate").getValue("metadata").jsonObject.getValue("count").jsonPrimitive.int)
    }

    @Test
    fun reportsTrueNorthWhenALocationGaveADeclination() {
        val north = manifest(capture(declination = 1.5)).getValue("metadata").jsonObject.getValue("trueNorth").jsonObject
        assertEquals("true", north.getValue("reference").jsonPrimitive.content)
        assertEquals("compass-median-true", north.getValue("method").jsonPrimitive.content)
        assertEquals(1.5, north.getValue("declinationDeg").jsonPrimitive.double, 1e-9)
        assertEquals(30.0, north.getValue("worldYawDeg").jsonPrimitive.double, 0.5)
        assertEquals(60, north.getValue("sampleCount").jsonPrimitive.int)
        assertTrue(north.getValue("confidence").jsonPrimitive.double in 0.0..1.0)
    }

    @Test
    fun withoutALocationItSaysMagneticNorth() {
        val m = manifest(capture(declination = null))
        val north = m.getValue("metadata").jsonObject.getValue("trueNorth").jsonObject
        assertEquals("magnetic", north.getValue("reference").jsonPrimitive.content)
        assertEquals("compass-median-magnetic", north.getValue("method").jsonPrimitive.content)
        assertEquals(JsonNull, north.getValue("declinationDeg"))
        assertFalse(streams(m).containsKey("geolocation"))
        assertNull(streams(m)["geolocation"])
    }

    @Test
    fun anglesNeverRoundUpTo360OrDownTo180Negative() {
        val samples = listOf(
            HeadingData(1L, 359.999, null, null, 3, null, 359.996),
            HeadingData(2L, 0.0, null, null, 3, null, 0.0),
        )
        val json = ScanBundle.heading(samples)
        val list = json.getValue("samples").jsonArray.map { it.jsonObject }
        assertEquals(0.0, list[0].getValue("azimuthMagneticDeg").jsonPrimitive.double, 0.0)
        assertEquals(0.0, list[0].getValue("worldBearingDeg").jsonPrimitive.double, 0.0)
        val yaw = ScanBundle.trueNorth(TrueNorthResult(-179.9999, 0.5, true, 4.0, 30, 0.0)).getValue("worldYawDeg").jsonPrimitive.double
        assertEquals(180.0, yaw, 0.0)
    }

    @Test
    fun truncationWarningsReachTheManifest() {
        val m = manifest(capture(declination = null, warnings = listOf("device-orientation-truncated")))
        val warnings = m.getValue("metadata").jsonObject.getValue("warnings").jsonArray.map { it.jsonPrimitive.content }
        assertTrue("device-orientation-truncated" in warnings)
        assertNotNull(warnings)
    }
}

class LightMathTest {
    @Test
    fun hdrKeepsAUnitMainLightAndDropsTheAmbientFields() {
        val r = LightMath.record(5L, true, true, 0.9f, floatArrayOf(1f, 1f, 1f, 1f), floatArrayOf(0f, 3f, 4f), floatArrayOf(2f, 2f, 2f))
        assertEquals("environmental-hdr", r.mode)
        assertTrue(r.valid)
        assertNull(r.pixelIntensity)
        assertNull(r.colorCorrection)
        assertEquals(0.6, r.mainLightDirection!![1], 1e-9)
        assertEquals(0.8, r.mainLightDirection!![2], 1e-9)
    }

    @Test
    fun ambientKeepsIntensityAndColourAndDropsTheMainLight() {
        val r = LightMath.record(5L, false, true, 0.4f, floatArrayOf(1f, 0.9f, 0.8f, 2.2f), floatArrayOf(0f, 1f, 0f), floatArrayOf(1f, 1f, 1f))
        assertEquals("ambient-intensity", r.mode)
        assertEquals(0.4, r.pixelIntensity!!, 1e-6)
        assertEquals(2.2, r.colorCorrection!![3], 1e-6)
        assertNull(r.mainLightDirection)
        assertNull(r.mainLightIntensity)
    }

    @Test
    fun invalidOrNonFiniteEstimatesCarryNothing() {
        for (r in listOf(
            LightMath.record(1L, true, false, 0f, null, null, null),
            LightMath.record(1L, true, true, 0f, null, floatArrayOf(Float.NaN, 0f, 1f), floatArrayOf(1f, 1f, 1f)),
            LightMath.record(1L, true, true, 0f, null, floatArrayOf(0f, 0f, 0f), floatArrayOf(1f, 1f, 1f)),
            LightMath.record(1L, true, true, 0f, null, floatArrayOf(0f, 1f, 0f), floatArrayOf(-1f, 1f, 1f)),
            LightMath.record(1L, false, true, Float.NaN, floatArrayOf(1f, 1f, 1f, 1f), null, null),
        )) {
            assertFalse(r.valid)
            assertNull(r.pixelIntensity)
            assertNull(r.mainLightDirection)
        }
    }
}
