package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeModelTest {
    private fun pose(tx: Float, ty: Float, tz: Float, alongZ: Boolean): FloatArray {
        // Local x runs along the wall, local z runs up, local y is the normal.
        val m = FloatArray(16)
        if (alongZ) { m[2] = 1f; m[4] = 1f } else { m[0] = 1f; m[6] = -1f }
        m[9] = 1f
        if (alongZ) m[6] = 0f
        m[10] = 0f
        m[15] = 1f
        m[12] = tx; m[13] = ty; m[14] = tz
        return m
    }

    private fun wall(id: String, cx: Float, cz: Float, length: Float, alongZ: Boolean, height: Float = 2.4f, state: String = "tracking"): PlaneRecord {
        val hx = length / 2
        val hz = height / 2
        return PlaneRecord(
            id, "vertical", pose(cx, hz, cz, alongZ), length, height,
            floatArrayOf(-hx, -hz, hx, -hz, hx, hz, -hx, hz), null, state,
        )
    }

    private fun horizontal(id: String, up: Boolean, y: Float): PlaneRecord {
        val m = FloatArray(16)
        m[0] = 1f; m[5] = 1f; m[10] = 1f; m[15] = 1f; m[13] = y
        return PlaneRecord(id, if (up) "horizontal-up" else "horizontal-down", m, 4f, 4f, floatArrayOf(-2f, -2f, 2f, -2f, 2f, 2f, -2f, 2f), null, "tracking")
    }

    /** A 4 x 3 m room: walls centred on the sides. */
    private fun room(withCeiling: Boolean = true): List<PlaneRecord> = buildList {
        add(horizontal("f", true, 0f))
        if (withCeiling) add(horizontal("c", false, 2.5f))
        add(wall("n", 0f, -1.5f, 4f, alongZ = false))
        add(wall("s", 0f, 1.5f, 4f, alongZ = false))
        add(wall("w", -2f, 0f, 3f, alongZ = true))
        add(wall("e", 2f, 0f, 3f, alongZ = true))
    }

    private fun settle(model: EdgeModel, planes: List<PlaneRecord>, times: Int = 4): EdgeSnapshot {
        var s = EdgeSnapshot.EMPTY
        repeat(times) { s = model.update(planes) }
        return s
    }

    @Test
    fun noFloorGivesNoEdges() {
        val s = EdgeModel().update(room().filter { it.orientation == "vertical" })
        assertTrue(s.edges.isEmpty())
        assertNull(s.floorY)
    }

    @Test
    fun roomGivesFloorWallCeilingAndCornerEdges() {
        val s = settle(EdgeModel(), room())
        assertEquals(0f, s.floorY!!, 0f)
        assertNotNull(s.ceilingY)
        assertEquals(4, s.edges.count { it.kind == EdgeKind.FLOOR_WALL })
        assertEquals(4, s.edges.count { it.kind == EdgeKind.WALL_CEILING })
        assertEquals(4, s.edges.count { it.kind == EdgeKind.CORNER })
        val corner = s.edges.first { it.kind == EdgeKind.CORNER }
        assertEquals(0f, corner.ay, 0f)
        assertEquals(2.5f, corner.by, 0.01f)
    }

    @Test
    fun withoutCeilingThereAreNoCeilingEdges() {
        val s = settle(EdgeModel(), room(withCeiling = false))
        assertEquals(0, s.edges.count { it.kind == EdgeKind.WALL_CEILING })
        assertTrue(s.edges.count { it.kind == EdgeKind.CORNER } == 4)
    }

    @Test
    fun closedRoomGivesAnOutlineWithTheRoomArea() {
        val s = settle(EdgeModel(), room())
        val outline = s.outline!!
        assertEquals(4, outline.size / 2)
        assertEquals(12f, abs(EdgeModel.signedArea(outline)), 0.2f)
    }

    @Test
    fun openCornerGivesNoOutline() {
        val s = settle(EdgeModel(), room().filter { it.id != "e" })
        assertNull(s.outline)
    }

    @Test
    fun newLinesFadeInAndAreNotFullyOpaqueOnFirstSight() {
        val model = EdgeModel()
        val first = model.update(room())
        val floorWall = first.edges.first { it.kind == EdgeKind.FLOOR_WALL }
        assertTrue(floorWall.alpha < 1f)
        val later = settle(model, room())
        assertEquals(1f, later.edges.first { it.kind == EdgeKind.FLOOR_WALL }.alpha, 0f)
    }

    @Test
    fun aGhostPlaneSeenOnceFadesOutAndIsDropped() {
        val model = EdgeModel()
        settle(model, room())
        val withGhost = room() + wall("g", 0f, 0f, 1.5f, alongZ = false)
        val seen = model.update(withGhost)
        assertEquals(5, seen.walls.size)
        var s = seen
        repeat(4) { s = model.update(room()) }
        assertEquals(4, s.walls.size)
    }

    @Test
    fun nearCollinearPlanesMergeIntoOneWall() {
        val planes = room().filter { it.id != "n" } +
            wall("n1", -1f, -1.5f, 2f, alongZ = false) + wall("n2", 1.05f, -1.52f, 2f, alongZ = false)
        val s = settle(EdgeModel(), planes)
        assertEquals(4, s.walls.size)
    }

    @Test
    fun tinyOrLowPlanesAreNotWalls() {
        val planes = listOf(horizontal("f", true, 0f), wall("short", 0f, 0f, 0.2f, alongZ = false), wall("low", 1f, 1f, 2f, alongZ = false, height = 0.3f))
        assertTrue(settle(EdgeModel(), planes).walls.isEmpty())
    }

    @Test
    fun subsumedAndLostPlanesAreIgnored() {
        val planes = room().map { if (it.id == "n") PlaneRecord(it.id, it.orientation, it.centerPose, it.extentX, it.extentZ, it.polygon, "s", it.trackingState) else it }
        assertEquals(3, settle(EdgeModel(), planes).walls.size)
        val paused = room().map { if (it.id == "w") PlaneRecord(it.id, it.orientation, it.centerPose, it.extentX, it.extentZ, it.polygon, null, "paused") else it }
        assertEquals(3, settle(EdgeModel(), paused).walls.size)
    }

    @Test
    fun triangulationCoversAnLShapedPolygon() {
        val l = floatArrayOf(0f, 0f, 4f, 0f, 4f, 2f, 2f, 2f, 2f, 4f, 0f, 4f)
        val tri = EdgeModel.triangulate(l)
        assertEquals(4 * 3, tri.size)
        var area = 0f
        for (i in tri.indices step 3) {
            val t = floatArrayOf(l[tri[i] * 2], l[tri[i] * 2 + 1], l[tri[i + 1] * 2], l[tri[i + 1] * 2 + 1], l[tri[i + 2] * 2], l[tri[i + 2] * 2 + 1])
            area += abs(EdgeModel.signedArea(t))
        }
        assertEquals(12f, area, 0.01f)
    }
}
