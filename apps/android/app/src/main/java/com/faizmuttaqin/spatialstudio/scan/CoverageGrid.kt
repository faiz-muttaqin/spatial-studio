package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.atan2
import kotlin.math.floor

/**
 * What a scan has seen of the floor: points near the floor plane binned into [cellMetres]
 * squares of the world XZ plane. A cell with [minPoints] or more is **covered**; a covered cell
 * next to an uncovered cell that lies inside the known floor extent is the **frontier**, where
 * to walk next. Points higher above the floor feed [WallBins] for the "wall not seen" cue.
 *
 * Cheap by design: counting only, no mesh fusion. The percentage is relative to the floor
 * extent ARCore has found so far (floor plane polygons plus covered cells), so it can fall
 * when the floor plane grows.
 *
 * Design after SceneView `ScanCoverage.kt` and `LiveCoverageGround.kt` (samples/android-demo,
 * `internal`), commit 820e17c8537b, Apache-2.0: 25 cm cells, covered and frontier cells.
 * Single-threaded: the GL thread feeds and reads it.
 */
class CoverageGrid(
    val cellMetres: Float = CELL_METRES,
    private val minPoints: Int = MIN_POINTS,
    private val floorBandM: Float = FLOOR_BAND_M,
) {
    private val counts = HashMap<Long, Int>()
    private val covered = LinkedHashSet<Long>()
    private var extent: Set<Long> = emptySet()
    val walls = WallBins(cellMetres)

    /** Height of the floor in the world frame; null until a floor plane is known. */
    var floorY: Float? = null
        private set

    /** Bumped when the covered set, the floor or the extent changes: a cheap "redraw?". */
    var version = 0
        private set

    val coveredCount: Int get() = covered.size

    fun setFloor(y: Float) {
        val current = floorY
        if (current != null && kotlin.math.abs(current - y) <= FLOOR_JITTER_M) return
        floorY = y
        version++
    }

    /** Cells (see [FloorExtent]) of the floor ARCore has found so far. */
    fun setExtent(cells: Set<Long>) {
        if (cells == extent) return
        extent = cells
        version++
    }

    /** Adds one world-space point; returns true when it was a floor point. */
    fun addPoint(x: Float, y: Float, z: Float): Boolean {
        val floor = floorY ?: return false
        if (!x.isFinite() || !y.isFinite() || !z.isFinite()) return false
        val height = y - floor
        if (height in -floorBandM..floorBandM) {
            val key = key(cell(x), cell(z))
            val n = (counts[key] ?: 0) + 1
            counts[key] = n
            if (n == minPoints && covered.add(key)) version++
            return true
        }
        if (height in WALL_MIN_HEIGHT_M..WALL_MAX_HEIGHT_M) walls.addHit(x, z)
        return false
    }

    /** Covered cells over covered plus the known floor cells not yet covered, `0..1`. */
    fun coveredShare(): Float {
        if (covered.isEmpty()) return 0f
        var gaps = 0
        for (cell in extent) if (cell !in covered) gaps++
        return covered.size.toFloat() / (covered.size + gaps)
    }

    /** Covered cells as `(cx, cz)` keys; [frontier] ones also listed in the second set. */
    fun cells(limit: Int = MAX_DRAWN_CELLS): Pair<List<Long>, Set<Long>> {
        val all = ArrayList<Long>(minOf(covered.size, limit))
        val frontier = HashSet<Long>()
        for (cell in covered) {
            if (all.size >= limit) break
            all.add(cell)
            if (isFrontier(cell)) frontier.add(cell)
        }
        return all to frontier
    }

    private fun isFrontier(cell: Long): Boolean {
        val cx = cx(cell)
        val cz = cz(cell)
        for ((dx, dz) in NEIGHBOURS) {
            val n = key(cx + dx, cz + dz)
            if (n !in covered && n in extent) return true
        }
        return false
    }

    fun cell(v: Float): Int = floor(v / cellMetres).toInt()

    companion object {
        const val CELL_METRES = 0.25f
        const val MIN_POINTS = 3
        const val FLOOR_JITTER_M = 0.03f
        const val FLOOR_BAND_M = 0.12f
        const val WALL_MIN_HEIGHT_M = 0.4f
        const val WALL_MAX_HEIGHT_M = 2.0f
        const val MAX_DRAWN_CELLS = 4000
        private val NEIGHBOURS = arrayOf(1 to 0, -1 to 0, 0 to 1, 0 to -1)

        fun key(cx: Int, cz: Int): Long = (cx.toLong() shl 32) xor (cz.toLong() and 0xffffffffL)
        fun cx(key: Long): Int = (key shr 32).toInt()
        fun cz(key: Long): Int = key.toInt()
    }
}

/** Cells of the floor planes ARCore has found: plane polygons sampled at cell centres. */
object FloorExtent {
    const val MAX_CELLS = 20_000

    /**
     * [planes] horizontal-up tracked planes at the floor height only; the polygon is plane-local
     * `x, z` pairs transformed by the plane's column-major `centerPose`.
     */
    fun cells(planes: List<PlaneRecord>, floorY: Float, cellMetres: Float, toleranceM: Float = 0.15f): Set<Long> {
        val out = HashSet<Long>()
        for (plane in planes) {
            if (plane.orientation != "horizontal-up" || plane.trackingState != "tracking" || plane.subsumedBy != null) continue
            val m = plane.centerPose
            if (m.size != 16 || kotlin.math.abs(m[13] - floorY) > toleranceM) continue
            val n = plane.polygon.size / 2
            if (n < 3) continue
            val xs = FloatArray(n)
            val zs = FloatArray(n)
            for (i in 0 until n) {
                val lx = plane.polygon[2 * i]
                val lz = plane.polygon[2 * i + 1]
                xs[i] = m[0] * lx + m[8] * lz + m[12]
                zs[i] = m[2] * lx + m[10] * lz + m[14]
            }
            val minCx = floor(xs.min() / cellMetres).toInt()
            val maxCx = floor(xs.max() / cellMetres).toInt()
            val minCz = floor(zs.min() / cellMetres).toInt()
            val maxCz = floor(zs.max() / cellMetres).toInt()
            for (cx in minCx..maxCx) for (cz in minCz..maxCz) {
                if (out.size >= MAX_CELLS) return out
                val px = (cx + 0.5f) * cellMetres
                val pz = (cz + 0.5f) * cellMetres
                if (inside(xs, zs, px, pz)) out.add(CoverageGrid.key(cx, cz))
            }
        }
        return out
    }

    private fun inside(xs: FloatArray, zs: FloatArray, px: Float, pz: Float): Boolean {
        var result = false
        var j = xs.size - 1
        for (i in xs.indices) {
            if ((zs[i] > pz) != (zs[j] > pz) && px < (xs[j] - xs[i]) * (pz - zs[i]) / (zs[j] - zs[i]) + xs[i]) result = !result
            j = i
        }
        return result
    }
}

/** Where, relative to the camera, a wall has not been seen yet. */
enum class WallSide { AHEAD, LEFT, RIGHT, BEHIND }

/**
 * Wall hits (points 0.4 to 2 m above the floor) binned into 25 cm cells, then read back as a
 * 12-sector histogram around the camera track's centre. A sector with enough hit cells counts
 * as a wall seen. This is a heuristic cue, not wall detection: it says where nothing at wall
 * height has been seen yet, which also happens at doorways and glass.
 */
class WallBins(private val cellMetres: Float = CoverageGrid.CELL_METRES) {
    private val hits = HashMap<Long, Int>()
    private var sumX = 0.0
    private var sumZ = 0.0
    private var samples = 0

    fun addHit(x: Float, z: Float) {
        val key = CoverageGrid.key(floor(x / cellMetres).toInt(), floor(z / cellMetres).toInt())
        hits[key] = (hits[key] ?: 0) + 1
    }

    /** One camera position per call, for the centre of the room. */
    fun addCamera(x: Float, z: Float) {
        sumX += x
        sumZ += z
        samples++
    }

    /** Sectors with a wall seen, `0..SECTORS`. */
    fun seenSectors(): Int = sectors().count { it }

    /**
     * The side of the nearest sector without a wall, for a camera looking along
     * ([forwardX], [forwardZ]) in the world XZ plane; null while fewer than [MIN_SECTORS_SEEN] are
     * known (a start-of-scan figure would mean nothing) or when every sector has a wall.
     */
    fun missingSide(forwardX: Float, forwardZ: Float): WallSide? {
        if (samples == 0) return null
        val seen = sectors()
        if (seen.count { it } < MIN_SECTORS_SEEN || seen.all { it }) return null
        val heading = atan2(forwardX, -forwardZ) // 0 = world -Z, towards +X
        var best = Float.MAX_VALUE
        var bestAngle = 0f
        for (s in 0 until SECTORS) {
            if (seen[s]) continue
            val bearing = ((s + 0.5f) * 2f * Math.PI.toFloat() / SECTORS) - Math.PI.toFloat()
            var rel = bearing - heading
            while (rel > Math.PI) rel -= (2 * Math.PI).toFloat()
            while (rel < -Math.PI) rel += (2 * Math.PI).toFloat()
            if (kotlin.math.abs(rel) < best) {
                best = kotlin.math.abs(rel)
                bestAngle = rel
            }
        }
        val deg = Math.toDegrees(bestAngle.toDouble())
        return when {
            kotlin.math.abs(deg) <= AHEAD_DEG -> WallSide.AHEAD
            kotlin.math.abs(deg) >= BEHIND_DEG -> WallSide.BEHIND
            deg > 0 -> WallSide.RIGHT
            else -> WallSide.LEFT
        }
    }

    private fun sectors(): BooleanArray {
        val seen = BooleanArray(SECTORS)
        if (samples == 0) return seen
        val centreX = (sumX / samples).toFloat()
        val centreZ = (sumZ / samples).toFloat()
        val cellsPerSector = IntArray(SECTORS)
        for ((key, n) in hits) {
            if (n < MIN_HITS_PER_CELL) continue
            val x = (CoverageGrid.cx(key) + 0.5f) * cellMetres
            val z = (CoverageGrid.cz(key) + 0.5f) * cellMetres
            cellsPerSector[sectorOf(x - centreX, z - centreZ)]++
        }
        for (s in 0 until SECTORS) seen[s] = cellsPerSector[s] >= MIN_CELLS_PER_SECTOR
        return seen
    }

    companion object {
        const val SECTORS = 12
        const val MIN_SECTORS_SEEN = 2
        private const val MIN_HITS_PER_CELL = 2
        private const val MIN_CELLS_PER_SECTOR = 3
        private const val AHEAD_DEG = 35.0
        private const val BEHIND_DEG = 135.0

        /** Sector of an offset from the centre; sector 0 starts at bearing -180 degrees. */
        fun sectorOf(dx: Float, dz: Float): Int {
            val bearing = atan2(dx, -dz) // 0 = -Z, positive towards +X
            val t = (bearing + Math.PI.toFloat()) / (2f * Math.PI.toFloat())
            return (t * SECTORS).toInt().coerceIn(0, SECTORS - 1)
        }
    }
}
