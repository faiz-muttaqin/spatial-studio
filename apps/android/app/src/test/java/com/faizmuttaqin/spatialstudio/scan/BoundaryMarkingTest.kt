package com.faizmuttaqin.spatialstudio.scan

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class BoundaryMarkingTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun hit(
        kind: HitKind = HitKind.HORIZONTAL_UP_PLANE,
        distance: Float = 2f,
        y: Float = -1.4f,
        inPolygon: Boolean = true,
        tracking: Boolean = true,
        normalY: Float = 1f,
        x: Float = 0f,
        z: Float = -2f,
    ): HitCandidate {
        val pose = Matrices.pose(x = x, y = y, z = z)
        pose[5] = normalY
        return HitCandidate(kind, inPolygon, tracking, distance, pose, "plane-1")
    }

    private fun accepted(decision: HitDecision) = (decision as HitDecision.Accepted).hit
    private fun refused(decision: HitDecision) = (decision as HitDecision.Refused).reason

    private fun floorPlane(y: Float = -1.4f, size: Float = 3f) =
        PlaneSummary("plane-1", HitKind.HORIZONTAL_UP_PLANE, true, y, size, size)

    private fun ceilingPlane(y: Float, size: Float = 3f, id: String = "plane-9", tracking: Boolean = true) =
        PlaneSummary(id, HitKind.HORIZONTAL_DOWN_PLANE, tracking, y, size, size)

    // --- hit filtering ---

    @Test
    fun acceptsATrackedFloorPlaneHitInsideItsPolygon() {
        val floor = hit()
        assertEquals(floor, accepted(BoundaryMarking.chooseFloorHit(listOf(floor), -1.4f)))
    }

    @Test
    fun refusesWhenNothingWasHit() {
        assertEquals(Refusal.NO_HIT, refused(BoundaryMarking.chooseFloorHit(emptyList(), null)))
    }

    @Test
    fun refusesFeaturePointsDepthPointsAndInstantPlacementAlone() {
        for (kind in listOf(HitKind.FEATURE_POINT, HitKind.DEPTH_POINT, HitKind.INSTANT_PLACEMENT, HitKind.OTHER)) {
            assertEquals(Refusal.NOT_FLOOR, refused(BoundaryMarking.chooseFloorHit(listOf(hit(kind = kind)), -1.4f)))
        }
    }

    @Test
    fun refusesVerticalAndCeilingPlanes() {
        assertEquals(Refusal.NOT_FLOOR, refused(BoundaryMarking.chooseFloorHit(listOf(hit(kind = HitKind.VERTICAL_PLANE)), -1.4f)))
        assertEquals(Refusal.NOT_FLOOR, refused(BoundaryMarking.chooseFloorHit(listOf(hit(kind = HitKind.HORIZONTAL_DOWN_PLANE, y = 1.0f)), -1.4f)))
    }

    @Test
    fun refusesAHitOutsideThePolygonOrWithAnInvertedNormal() {
        assertEquals(Refusal.NOT_FLOOR, refused(BoundaryMarking.chooseFloorHit(listOf(hit(inPolygon = false)), -1.4f)))
        assertEquals(Refusal.NOT_FLOOR, refused(BoundaryMarking.chooseFloorHit(listOf(hit(normalY = 0.5f)), -1.4f)))
    }

    @Test
    fun refusesAnUntrackedPlane() {
        assertEquals(Refusal.NOT_TRACKING, refused(BoundaryMarking.chooseFloorHit(listOf(hit(tracking = false)), -1.4f)))
    }

    @Test
    fun refusesADepthPointOnGlassInFrontOfTheFloor() {
        // The glass surface returns a depth point 1.2 m away; the floor plane is hit behind it at 2 m.
        val glass = hit(kind = HitKind.DEPTH_POINT, distance = 1.2f, y = -0.2f)
        val floor = hit(distance = 2f)
        assertEquals(Refusal.OBSTRUCTED, refused(BoundaryMarking.chooseFloorHit(listOf(glass, floor), -1.4f)))
    }

    @Test
    fun refusesAVerticalPlaneInFrontOfTheFloor() {
        val wall = hit(kind = HitKind.VERTICAL_PLANE, distance = 1.5f)
        assertEquals(Refusal.OBSTRUCTED, refused(BoundaryMarking.chooseFloorHit(listOf(wall, hit(distance = 2.5f)), -1.4f)))
    }

    @Test
    fun toleratesADepthPointRightOnTheFloor() {
        val noise = hit(kind = HitKind.DEPTH_POINT, distance = 1.97f)
        val floor = hit(distance = 2f)
        assertEquals(floor, accepted(BoundaryMarking.chooseFloorHit(listOf(noise, floor), -1.4f)))
    }

    @Test
    fun refusesATableTopAboveTheFloor() {
        assertEquals(Refusal.ABOVE_FLOOR, refused(BoundaryMarking.chooseFloorHit(listOf(hit(y = -0.6f)), -1.4f)))
        assertEquals(Refusal.ABOVE_FLOOR, refused(BoundaryMarking.chooseFloorHit(listOf(hit(y = -1.1f)), -1.4f)))
        // Within tolerance of the lowest floor plane.
        assertNotNull(accepted(BoundaryMarking.chooseFloorHit(listOf(hit(y = -1.2f)), -1.4f)))
    }

    @Test
    fun refusesTooCloseAndTooFar() {
        assertEquals(Refusal.OUT_OF_RANGE, refused(BoundaryMarking.chooseFloorHit(listOf(hit(distance = 0.1f)), -1.4f)))
        assertEquals(Refusal.OUT_OF_RANGE, refused(BoundaryMarking.chooseFloorHit(listOf(hit(distance = 9f)), -1.4f)))
    }

    @Test
    fun withoutAKnownFloorTheHitItselfIsTheReference() {
        assertNotNull(accepted(BoundaryMarking.chooseFloorHit(listOf(hit(y = 0.9f)), null)))
    }

    @Test
    fun floorLevelIsTheLowestTrackedUpwardPlaneOfUsefulSize() {
        val planes = listOf(
            floorPlane(y = -1.4f),
            PlaneSummary("table", HitKind.HORIZONTAL_UP_PLANE, true, -0.7f, 1f, 1f),
            PlaneSummary("speck", HitKind.HORIZONTAL_UP_PLANE, true, -2f, 0.2f, 0.2f),
            PlaneSummary("lost", HitKind.HORIZONTAL_UP_PLANE, false, -3f, 2f, 2f),
            ceilingPlane(y = 1.1f),
        )
        assertEquals(-1.4f, BoundaryMarking.floorY(planes)!!, 0f)
        assertNull(BoundaryMarking.floorY(listOf(ceilingPlane(y = 1.1f))))
        assertNull(BoundaryMarking.floorY(emptyList()))
    }

    // --- ceiling height ---

    @Test
    fun ceilingHeightIsTheCeilingPlaneAboveTheBase() {
        val pick = BoundaryMarking.ceilingHeight(-1.4, listOf(ceilingPlane(y = 1.2f)))!!
        assertEquals(2.6, pick.heightM, 1e-6)
        assertEquals("plane-9", pick.planeId)
    }

    @Test
    fun ceilingPicksTheLargestTrackedPlaneInRange() {
        val planes = listOf(
            ceilingPlane(y = 0.9f, size = 0.8f, id = "soffit"),
            ceilingPlane(y = 1.2f, size = 3f, id = "ceiling"),
            ceilingPlane(y = 1.3f, size = 5f, id = "lost", tracking = false),
            ceilingPlane(y = 6.5f, size = 9f, id = "too-high"),
            floorPlane(),
        )
        assertEquals("ceiling", BoundaryMarking.ceilingHeight(-1.4, planes)!!.planeId)
    }

    @Test
    fun noCeilingWhenNoneIsTrackedOrInRange() {
        assertNull(BoundaryMarking.ceilingHeight(-1.4, emptyList()))
        assertNull(BoundaryMarking.ceilingHeight(-1.4, listOf(ceilingPlane(y = 0.1f)))) // 1.5 m: a table, not a ceiling
        assertNull(BoundaryMarking.ceilingHeight(-1.4, listOf(floorPlane())))
    }

    @Test
    fun typedHeightParsing() {
        assertEquals(2.4, BoundaryMarking.parseTypedHeight("2.4")!!, 0.0)
        assertEquals(2.4, BoundaryMarking.parseTypedHeight(" 2,4 ")!!, 0.0)
        assertNull(BoundaryMarking.parseTypedHeight(""))
        assertNull(BoundaryMarking.parseTypedHeight(null))
        assertNull(BoundaryMarking.parseTypedHeight("abc"))
        assertNull(BoundaryMarking.parseTypedHeight("NaN"))
        assertNull(BoundaryMarking.parseTypedHeight("0.05"))
        assertNull(BoundaryMarking.parseTypedHeight("10.5"))
        assertEquals(10.0, BoundaryMarking.parseTypedHeight("10")!!, 0.0)
    }

    @Test
    fun heightChoicePrefersTypedThenCeilingThenUnknown() {
        val planes = listOf(ceilingPlane(y = 1.2f))
        val typed = BoundaryMarking.resolveHeight(BoundaryKind.WALL, 2.0, -1.4, planes)
        assertEquals(HeightSource.TYPED, typed.source)
        assertEquals(2.0, typed.metres!!, 0.0)
        assertNull(typed.ceilingPlaneId)

        val ceiling = BoundaryMarking.resolveHeight(BoundaryKind.GLASS, null, -1.4, planes)
        assertEquals(HeightSource.CEILING_PLANE, ceiling.source)
        assertEquals(2.6, ceiling.metres!!, 1e-6)
        assertEquals("plane-9", ceiling.ceilingPlaneId)

        val none = BoundaryMarking.resolveHeight(BoundaryKind.WALL, null, -1.4, emptyList())
        assertEquals(HeightSource.UNKNOWN, none.source)
        assertNull(none.metres)
    }

    @Test
    fun doorsAndOpeningsNeverTakeTheCeilingHeight() {
        val planes = listOf(ceilingPlane(y = 1.2f))
        for (kind in listOf(BoundaryKind.DOOR, BoundaryKind.OPENING)) {
            assertEquals(HeightSource.UNKNOWN, BoundaryMarking.resolveHeight(kind, null, -1.4, planes).source)
            assertEquals(HeightSource.TYPED, BoundaryMarking.resolveHeight(kind, 2.1, -1.4, planes).source)
        }
    }

    // --- the mark book ---

    private fun point(x: Float, z: Float, y: Float = -1.4f, ts: Long = 1000L) = BasePoint(Matrices.pose(x = x, y = y, z = z), "plane-1", ts)

    private val unknownHeight = { _: BoundaryKind, _: Double -> BoundaryMarking.HeightChoice(null, HeightSource.UNKNOWN, null) }

    @Test
    fun twoTapsMakeAMarkInTapOrder() {
        val book = BoundaryMarkBook()
        assertTrue(book.tap(BoundaryKind.GLASS, point(0f, 0f), 10L, unknownHeight) is BoundaryMarkBook.Result.Started)
        assertNotNull(book.pending())
        val done = book.tap(BoundaryKind.WALL, point(3f, 0f, y = -1.38f), 20L) { kind, y ->
            assertEquals(BoundaryKind.GLASS, kind)
            assertEquals(-1.39, y, 1e-6)
            BoundaryMarking.HeightChoice(2.5, HeightSource.TYPED, null)
        } as BoundaryMarkBook.Result.Completed
        assertEquals("mark-001", done.mark.id)
        // The kind chosen at the first tap sticks.
        assertEquals(BoundaryKind.GLASS, done.mark.kind)
        assertEquals(20L, done.mark.createdAtMs)
        assertEquals(0f, done.mark.start.x, 0f)
        assertEquals(3f, done.mark.end.x, 0f)
        assertNull(book.pending())
        assertEquals(1, book.count())
    }

    @Test
    fun refusesAShortLongOrSlantedBaseAndKeepsTheStart() {
        val book = BoundaryMarkBook()
        book.tap(BoundaryKind.WALL, point(0f, 0f), 1L, unknownHeight)
        assertTrue(book.tap(BoundaryKind.WALL, point(0.02f, 0f), 2L, unknownHeight) is BoundaryMarkBook.Result.TooShort)
        assertTrue(book.tap(BoundaryKind.WALL, point(60f, 0f), 2L, unknownHeight) is BoundaryMarkBook.Result.TooLong)
        assertTrue(book.tap(BoundaryKind.WALL, point(2f, 0f, y = -0.5f), 2L, unknownHeight) is BoundaryMarkBook.Result.TooSteep)
        assertNotNull(book.pending())
        assertEquals(0, book.count())
        assertTrue(book.tap(BoundaryKind.WALL, point(2f, 0f), 3L, unknownHeight) is BoundaryMarkBook.Result.Completed)
    }

    @Test
    fun undoDropsThePendingStartFirstThenTheLastMark() {
        val book = BoundaryMarkBook()
        book.tap(BoundaryKind.WALL, point(0f, 0f), 1L, unknownHeight)
        book.tap(BoundaryKind.WALL, point(2f, 0f), 2L, unknownHeight)
        book.tap(BoundaryKind.DOOR, point(2f, 0f), 3L, unknownHeight)
        assertTrue(book.undo())
        assertNull(book.pending())
        assertEquals(1, book.count())
        assertTrue(book.undo())
        assertEquals(0, book.count())
        assertFalse(book.undo())
    }

    @Test
    fun idsStayUniqueAfterUndo() {
        val book = BoundaryMarkBook()
        repeat(2) { book.tap(BoundaryKind.WALL, point(0f, 0f), 1L, unknownHeight); book.tap(BoundaryKind.WALL, point(2f, 0f), 2L, unknownHeight) }
        book.undo()
        book.tap(BoundaryKind.WALL, point(0f, 0f), 3L, unknownHeight)
        book.tap(BoundaryKind.WALL, point(0f, 2f), 4L, unknownHeight)
        assertEquals(listOf("mark-001", "mark-002"), book.snapshot().map { it.id })
    }

    @Test
    fun stopsAtTheMarkLimit() {
        val book = BoundaryMarkBook()
        repeat(BoundaryMarking.MAX_MARKS) {
            book.tap(BoundaryKind.WALL, point(0f, 0f), 1L, unknownHeight)
            book.tap(BoundaryKind.WALL, point(2f, 0f), 2L, unknownHeight)
        }
        assertTrue(book.tap(BoundaryKind.WALL, point(0f, 0f), 3L, unknownHeight) is BoundaryMarkBook.Result.Full)
    }

    // --- serialisation ---

    private fun sampleMarks(): List<BoundaryMark> {
        val book = BoundaryMarkBook()
        book.tap(BoundaryKind.GLASS, point(0f, 0f, ts = 11L), 1L, unknownHeight)
        book.tap(BoundaryKind.GLASS, point(3f, 0.0004f, y = -1.38f, ts = 12L), 1_764_057_700_000L) { _, _ ->
            BoundaryMarking.HeightChoice(2.6, HeightSource.CEILING_PLANE, "plane-9")
        }
        book.tap(BoundaryKind.DOOR, point(3f, 0f), 2L, unknownHeight)
        book.tap(BoundaryKind.DOOR, point(3.9f, 0f), 1_764_057_800_000L, unknownHeight)
        return book.snapshot()
    }

    @Test
    fun serialisesMarksToTheContractShape() {
        val json = ScanBundle.boundaryMarks(sampleMarks())
        val marks = json.getValue("marks").jsonArray.map { it.jsonObject }
        assertEquals(2, marks.size)
        val glass = marks[0]
        assertEquals("mark-001", glass.getValue("id").jsonPrimitive.content)
        assertEquals("glass", glass.getValue("kind").jsonPrimitive.content)
        assertEquals("manual-ar-marking", glass.getValue("source").jsonPrimitive.content)
        assertEquals(1_764_057_700_000L, glass.getValue("createdAt").jsonPrimitive.long)
        assertEquals(JsonNull, glass.getValue("notes"))
        val base = glass.getValue("base").jsonArray.map { it.jsonObject }
        assertEquals(2, base.size)
        assertEquals(listOf(0.0, -1.4, 0.0), base[0].getValue("point").jsonArray.map { it.jsonPrimitive.double })
        assertEquals(listOf(3.0, -1.38, 0.0004), base[1].getValue("point").jsonArray.map { it.jsonPrimitive.double })
        assertEquals(16, base[1].getValue("pose").jsonArray.size)
        assertEquals("plane-1", base[0].getValue("planeId").jsonPrimitive.content)
        assertEquals(11L, base[0].getValue("timestamp").jsonPrimitive.long)
        val height = glass.getValue("height").jsonObject
        assertEquals(2.6, height.getValue("metres").jsonPrimitive.double, 0.0)
        assertEquals("ceiling-plane", height.getValue("source").jsonPrimitive.content)
        assertEquals("plane-9", height.getValue("ceilingPlaneId").jsonPrimitive.content)

        val door = marks[1].getValue("height").jsonObject
        assertEquals(JsonNull, door.getValue("metres"))
        assertEquals("unknown", door.getValue("source").jsonPrimitive.content)
        assertEquals(JsonNull, door.getValue("ceilingPlaneId"))
    }

    @Test
    fun pointMatchesPoseTranslation() {
        val marks = ScanBundle.boundaryMarks(sampleMarks()).getValue("marks").jsonArray.map { it.jsonObject }
        for (mark in marks) for (base in mark.getValue("base").jsonArray.map { it.jsonObject }) {
            val point = base.getValue("point").jsonArray.map { it.jsonPrimitive.double }
            val pose = base.getValue("pose").jsonArray.map { it.jsonPrimitive.double }
            for (i in 0..2) assertEquals(point[i], pose[12 + i], 1e-6)
        }
    }

    private fun finalizeWith(marks: List<BoundaryMark>): JsonObject {
        val dir = tmp.newFolder("bundle-${marks.size}")
        ScanBundleWriter(dir).finalize(TestBundles.write(dir, boundaryMarks = marks))
        System.getenv("BOUNDARY_BUNDLE_FIXTURE_DIR")?.takeIf { marks.isNotEmpty() }?.let { out -> dir.copyRecursively(File(out), overwrite = true) }
        return Json.parseToJsonElement(File(dir, "manifest.json").readText()).jsonObject
    }

    private fun streamIds(manifest: JsonObject) = manifest.getValue("streams").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }

    @Test
    fun noMarksWritesNoStream() {
        val manifest = finalizeWith(emptyList())
        assertFalse("boundary-marks" in streamIds(manifest))
    }

    @Test
    fun marksAreWrittenAsAnArtifactStream() {
        val manifest = finalizeWith(sampleMarks())
        val stream = manifest.getValue("streams").jsonArray.map { it.jsonObject }.single { it.getValue("id").jsonPrimitive.content == "boundary-marks" }
        assertEquals("boundary-marks", stream.getValue("kind").jsonPrimitive.content)
        assertEquals("boundaryMarks", stream.getValue("role").jsonPrimitive.content)
        assertEquals("world", stream.getValue("frameId").jsonPrimitive.content)
        assertEquals("application/json", stream.getValue("artifact").jsonObject.getValue("mediaType").jsonPrimitive.content)
        assertEquals(2L, stream.getValue("metadata").jsonObject.getValue("count").jsonPrimitive.long)
    }

    @Test
    fun aMarkWithANonFinitePoseIsDroppedWithAWarning() {
        val bad = BoundaryMark("mark-009", BoundaryKind.WALL, point(0f, 0f), BasePoint(Matrices.pose(x = Float.NaN), null, 1L), BoundaryMarking.HeightChoice(null, HeightSource.UNKNOWN, null), 1L)
        val manifest = finalizeWith(listOf(bad))
        assertFalse("boundary-marks" in streamIds(manifest))
        val warnings = manifest.getValue("metadata").jsonObject.getValue("warnings").jsonArray.map { it.jsonPrimitive.content }
        assertTrue("boundary-mark-invalid" in warnings)
    }
}
