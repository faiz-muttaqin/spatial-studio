package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CoverageGridTest {
    private fun grid() = CoverageGrid().also { it.setFloor(0f) }

    @Test fun `no floor means no coverage`() {
        val g = CoverageGrid()
        assertFalse(g.addPoint(1f, 0f, 1f))
        assertEquals(0, g.coveredCount)
    }

    @Test fun `a cell needs three floor points`() {
        val g = grid()
        g.addPoint(0.1f, 0.02f, 0.1f)
        g.addPoint(0.12f, -0.03f, 0.1f)
        assertEquals(0, g.coveredCount)
        g.addPoint(0.2f, 0f, 0.2f)
        assertEquals(1, g.coveredCount)
        g.addPoint(0.2f, 0f, 0.2f)
        assertEquals(1, g.coveredCount)
    }

    @Test fun `points off the floor band do not cover it`() {
        val g = grid()
        repeat(5) { g.addPoint(0.1f, 0.5f, 0.1f) }
        repeat(5) { g.addPoint(0.1f, -0.5f, 0.1f) }
        assertEquals(0, g.coveredCount)
    }

    @Test fun `negative coordinates land in their own cells`() {
        val g = grid()
        repeat(3) { g.addPoint(-0.1f, 0f, -0.1f) }
        repeat(3) { g.addPoint(0.1f, 0f, 0.1f) }
        assertEquals(2, g.coveredCount)
        val (cells, _) = g.cells()
        assertTrue(CoverageGrid.key(-1, -1) in cells)
        assertTrue(CoverageGrid.key(0, 0) in cells)
    }

    @Test fun `share is covered over covered plus known gaps`() {
        val g = grid()
        g.setExtent(setOf(CoverageGrid.key(0, 0), CoverageGrid.key(1, 0), CoverageGrid.key(2, 0), CoverageGrid.key(3, 0)))
        repeat(3) { g.addPoint(0.1f, 0f, 0.1f) }
        assertEquals(0.25f, g.coveredShare(), 1e-6f)
        repeat(3) { g.addPoint(0.35f, 0f, 0.1f) }
        assertEquals(0.5f, g.coveredShare(), 1e-6f)
    }

    @Test fun `covered cells outside the extent still count and cap the share at one`() {
        val g = grid()
        repeat(3) { g.addPoint(5.1f, 0f, 5.1f) }
        assertEquals(1f, g.coveredShare(), 1e-6f)
    }

    @Test fun `frontier is a covered cell next to a known uncovered cell`() {
        val g = grid()
        g.setExtent(setOf(CoverageGrid.key(0, 0), CoverageGrid.key(1, 0), CoverageGrid.key(2, 0)))
        repeat(3) { g.addPoint(0.1f, 0f, 0.1f) }
        repeat(3) { g.addPoint(0.35f, 0f, 0.1f) }
        val (cells, frontier) = g.cells()
        assertEquals(2, cells.size)
        assertEquals(setOf(CoverageGrid.key(1, 0)), frontier)
    }

    @Test fun `version bumps only when something visible changes`() {
        val g = grid()
        val v0 = g.version
        g.addPoint(0.1f, 0f, 0.1f)
        assertEquals(v0, g.version)
        repeat(2) { g.addPoint(0.1f, 0f, 0.1f) }
        assertEquals(v0 + 1, g.version)
        g.addPoint(0.1f, 0f, 0.1f)
        assertEquals(v0 + 1, g.version)
    }

    @Test fun `non finite points are ignored`() {
        val g = grid()
        assertFalse(g.addPoint(Float.NaN, 0f, 0f))
        assertFalse(g.addPoint(0f, Float.POSITIVE_INFINITY, 0f))
    }

    @Test fun `key packing round trips`() {
        for ((a, b) in listOf(0 to 0, -1 to 1, 1 to -1, -123456 to 98765)) {
            val k = CoverageGrid.key(a, b)
            assertEquals(a, CoverageGrid.cx(k))
            assertEquals(b, CoverageGrid.cz(k))
        }
    }

    private fun plane(centerY: Float, polygon: FloatArray, orientation: String = "horizontal-up", subsumed: String? = null) =
        PlaneRecord("p", orientation, Matrices.pose(y = centerY), 4f, 4f, polygon, subsumed, "tracking")

    @Test fun `floor extent fills a square plane polygon with cell centres`() {
        // A 1 m square centred on the origin: 4 x 4 cells of 25 cm.
        val square = floatArrayOf(-0.5f, -0.5f, 0.5f, -0.5f, 0.5f, 0.5f, -0.5f, 0.5f)
        val cells = FloorExtent.cells(listOf(plane(0f, square)), 0f, 0.25f)
        assertEquals(16, cells.size)
    }

    @Test fun `floor extent ignores other heights, orientations and subsumed planes`() {
        val square = floatArrayOf(-0.5f, -0.5f, 0.5f, -0.5f, 0.5f, 0.5f, -0.5f, 0.5f)
        val planes = listOf(
            plane(0.8f, square),
            plane(0f, square, orientation = "vertical"),
            plane(0f, square, subsumed = "plane-9"),
        )
        assertTrue(FloorExtent.cells(planes, 0f, 0.25f).isEmpty())
    }

    // --- Wall cue ---

    /** Wall hits on a ring of [radius] around the origin, over [fromDeg, toDeg) of bearing (0 = world -Z, 90 = +X). */
    private fun WallBins.ring(fromDeg: Int, toDeg: Int, radius: Float = 6f) {
        for (deg in fromDeg until toDeg step 3) {
            val r = Math.toRadians(deg.toDouble())
            val x = (radius * Math.sin(r)).toFloat()
            val z = (-radius * Math.cos(r)).toFloat()
            repeat(3) { addHit(x, z) }
        }
    }

    @Test fun `no cue before two sectors are known`() {
        val bins = WallBins()
        bins.addCamera(0f, 0f)
        bins.ring(0, 30)
        assertNull(bins.missingSide(0f, -1f))
    }

    @Test fun `no cue once every sector has a wall`() {
        val bins = WallBins()
        bins.addCamera(0f, 0f)
        bins.ring(0, 360)
        assertEquals(WallBins.SECTORS, bins.seenSectors())
        assertNull(bins.missingSide(0f, -1f))
    }

    /** Walls seen all round except the 30 degree sector centred on [missingBearingDeg]; sector centres are at 15 + 30k degrees. */
    private fun allBut(missingBearingDeg: Int): WallBins {
        val bins = WallBins()
        bins.addCamera(0f, 0f)
        bins.ring(missingBearingDeg + 18, missingBearingDeg + 342)
        assertEquals(WallBins.SECTORS - 1, bins.seenSectors())
        return bins
    }

    @Test fun `the cue names the side of the missing wall`() {
        // Facing -Z (bearing 0): forward is (0, -1).
        assertEquals(WallSide.AHEAD, allBut(-15).missingSide(0f, -1f))
        assertEquals(WallSide.LEFT, allBut(-75).missingSide(0f, -1f))
        assertEquals(WallSide.RIGHT, allBut(105).missingSide(0f, -1f))
        assertEquals(WallSide.BEHIND, allBut(165).missingSide(0f, -1f))
    }

    @Test fun `the cue follows the camera heading`() {
        // The gap is just past +X (bearing 105). Facing +X it is ahead; facing -X behind; facing +Z on the left.
        val bins = allBut(105)
        assertEquals(WallSide.AHEAD, bins.missingSide(1f, 0f))
        assertEquals(WallSide.BEHIND, bins.missingSide(-1f, 0f))
        assertEquals(WallSide.LEFT, bins.missingSide(0f, 1f))
    }

    @Test fun `thin hits do not make a wall`() {
        val bins = WallBins()
        bins.addCamera(0f, 0f)
        bins.addHit(3f, 0f)
        assertEquals(0, bins.seenSectors())
    }

    @Test fun `floor points do not feed the wall cue`() {
        val g = grid()
        repeat(3) { g.addPoint(3f, 1.0f, 0f) }
        repeat(3) { g.addPoint(3f, 0f, 0f) }
        assertEquals(1, g.coveredCount)
    }
}
