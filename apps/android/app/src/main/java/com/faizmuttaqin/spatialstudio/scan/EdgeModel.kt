package com.faizmuttaqin.spatialstudio.scan

import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

enum class EdgeKind { FLOOR_WALL, CORNER, WALL_CEILING }

/** One line segment in ARCore world metres. [alpha] is 0..1 and drives the fade of unconfirmed lines. */
class LiveEdge(
    val kind: EdgeKind,
    val ax: Float, val ay: Float, val az: Float,
    val bx: Float, val by: Float, val bz: Float,
    val alpha: Float,
)

/** A tracked wall footprint on the floor, endpoints snapped to corners when they exist. */
class LiveWall(val ax: Float, val az: Float, val bx: Float, val bz: Float, val topY: Float)

/**
 * What the screen draws. Immutable; produced off the GL thread and swapped in whole.
 * [outline] is a closed floor polygon (x, z pairs, no repeated first point) when the confirmed walls form a loop.
 */
class EdgeSnapshot(
    val version: Long,
    val floorY: Float?,
    val ceilingY: Float?,
    val edges: List<LiveEdge>,
    val walls: List<LiveWall>,
    val outline: FloatArray?,
) {
    companion object {
        val EMPTY = EdgeSnapshot(0, null, null, emptyList(), emptyList(), null)
    }
}

/**
 * Live edge model built from ARCore planes: floor-wall lines, vertical corner lines and wall-ceiling lines.
 * Not thread-safe; feed it from one thread. Everything here is pure maths so it runs in unit tests.
 *
 * Stability: a wall footprint is tracked across updates. A new footprint must be seen again before it is trusted
 * (its alpha ramps up over a few updates), near-collinear footprints merge, and a footprint that stops being
 * reported fades out instead of vanishing.
 */
class EdgeModel {
    private class Track(
        var px: Float, var pz: Float,
        var dx: Float, var dz: Float,
        var t0: Float, var t1: Float,
        var topY: Float,
    ) {
        var confidence = RISE
        var hits = 1
        val confirmed: Boolean get() = hits >= CONFIRM_HITS
        fun ax() = px + dx * t0
        fun az() = pz + dz * t0
        fun bx() = px + dx * t1
        fun bz() = pz + dz * t1
    }

    private val tracks = ArrayList<Track>()
    private var version = 0L

    fun update(planes: List<PlaneRecord>): EdgeSnapshot {
        val live = planes.filter { it.trackingState == "tracking" && it.subsumedBy == null && it.centerPose.size == 16 }
        val summaries = live.filter { it.orientation != "vertical" }.map {
            PlaneSummary(it.id, if (it.orientation == "horizontal-up") HitKind.HORIZONTAL_UP_PLANE else HitKind.HORIZONTAL_DOWN_PLANE, true, it.centerPose[13], it.extentX, it.extentZ)
        }
        val floorY = BoundaryMarking.floorY(summaries)
        val ceilingY = floorY?.let { f -> BoundaryMarking.ceilingHeight(f.toDouble(), summaries)?.let { f + it.heightM.toFloat() } }

        val seen = BooleanArray(tracks.size)
        val fresh = ArrayList<Track>()
        for (plane in live) {
            if (plane.orientation != "vertical") continue
            val cand = footprint(plane) ?: continue
            val i = tracks.indexOfFirst { matches(it, cand) }
            if (i >= 0) {
                if (!seen[i]) absorb(tracks[i], cand)
                seen[i] = true
            } else {
                // Two reported planes on one wall merge into one new track.
                val j = fresh.indexOfFirst { matches(it, cand) }
                if (j >= 0) absorb(fresh[j], cand) else fresh.add(cand)
            }
        }
        for (i in tracks.indices) {
            if (seen[i]) {
                tracks[i].hits++
                tracks[i].confidence = min(1f, tracks[i].confidence + RISE)
            } else {
                tracks[i].confidence -= FALL
            }
        }
        tracks.removeAll { it.confidence <= 0f }
        tracks.addAll(fresh)
        mergeTracks()
        version++
        if (floorY == null) return EdgeSnapshot(version, null, ceilingY, emptyList(), emptyList(), null)
        return build(floorY, ceilingY)
    }

    /** Horizontal footprint of a vertical plane: principal direction of its polygon in the XZ plane. */
    private fun footprint(plane: PlaneRecord): Track? {
        val n = plane.polygon.size / 2
        if (n < 3) return null
        val m = plane.centerPose
        val xs = FloatArray(n)
        val zs = FloatArray(n)
        var minY = Float.MAX_VALUE
        var maxY = -Float.MAX_VALUE
        var cx = 0f
        var cz = 0f
        for (i in 0 until n) {
            val lx = plane.polygon[i * 2]
            val lz = plane.polygon[i * 2 + 1]
            val wx = m[12] + m[0] * lx + m[8] * lz
            val wy = m[13] + m[1] * lx + m[9] * lz
            val wz = m[14] + m[2] * lx + m[10] * lz
            xs[i] = wx
            zs[i] = wz
            minY = min(minY, wy)
            maxY = max(maxY, wy)
            cx += wx
            cz += wz
        }
        cx /= n
        cz /= n
        var sxx = 0f
        var szz = 0f
        var sxz = 0f
        for (i in 0 until n) {
            val ex = xs[i] - cx
            val ez = zs[i] - cz
            sxx += ex * ex
            szz += ez * ez
            sxz += ex * ez
        }
        val angle = 0.5f * kotlin.math.atan2(2f * sxz, sxx - szz)
        val dx = kotlin.math.cos(angle)
        val dz = kotlin.math.sin(angle)
        var t0 = Float.MAX_VALUE
        var t1 = -Float.MAX_VALUE
        var across = 0f
        for (i in 0 until n) {
            val t = (xs[i] - cx) * dx + (zs[i] - cz) * dz
            t0 = min(t0, t)
            t1 = max(t1, t)
            across = max(across, abs(-(xs[i] - cx) * dz + (zs[i] - cz) * dx))
        }
        // A vertical plane's polygon is thin in the horizontal plane; a wide blob is not a wall.
        if (t1 - t0 < MIN_WALL_LENGTH || across > MAX_ACROSS_M) return null
        if (maxY - minY < MIN_WALL_HEIGHT) return null
        return Track(cx, cz, dx, dz, t0, t1, maxY)
    }

    private fun matches(a: Track, b: Track): Boolean {
        val cos = abs(a.dx * b.dx + a.dz * b.dz)
        if (cos < COS_MATCH) return false
        // Perpendicular distance of b's ends from a's line, then the gap along a.
        for (e in 0..1) {
            val x = if (e == 0) b.ax() else b.bx()
            val z = if (e == 0) b.az() else b.bz()
            if (abs(-(x - a.px) * a.dz + (z - a.pz) * a.dx) > MATCH_DIST_M) return false
        }
        val bt0 = (b.ax() - a.px) * a.dx + (b.az() - a.pz) * a.dz
        val bt1 = (b.bx() - a.px) * a.dx + (b.bz() - a.pz) * a.dz
        val gap = max(min(bt0, bt1) - a.t1, a.t0 - max(bt0, bt1))
        return gap <= MATCH_GAP_M
    }

    /** Folds [c] into [t]: the span is the union and the line moves a fraction toward the new fit. */
    private fun absorb(t: Track, c: Track) {
        val sign = if (t.dx * c.dx + t.dz * c.dz < 0f) -1f else 1f
        val c0 = (c.ax() - t.px) * t.dx + (c.az() - t.pz) * t.dz
        val c1 = (c.bx() - t.px) * t.dx + (c.bz() - t.pz) * t.dz
        val lo = min(t.t0, min(c0, c1))
        val hi = max(t.t1, max(c0, c1))
        // Move the anchor point toward the candidate's centre and the direction toward its direction.
        val ccx = (c.ax() + c.bx()) / 2
        val ccz = (c.az() + c.bz()) / 2
        val offset = -(ccx - t.px) * t.dz + (ccz - t.pz) * t.dx
        val ox = -t.dz * offset * SMOOTH
        val oz = t.dx * offset * SMOOTH
        var ndx = t.dx + sign * c.dx * SMOOTH
        var ndz = t.dz + sign * c.dz * SMOOTH
        val len = hypot(ndx, ndz)
        ndx /= len
        ndz /= len
        // Re-express the span about the shifted anchor and direction.
        val ax = t.px + t.dx * lo + ox
        val az = t.pz + t.dz * lo + oz
        val bx = t.px + t.dx * hi + ox
        val bz = t.pz + t.dz * hi + oz
        t.px = ax
        t.pz = az
        t.dx = ndx
        t.dz = ndz
        t.t0 = 0f
        t.t1 = (bx - ax) * ndx + (bz - az) * ndz
        t.topY = max(t.topY, c.topY)
    }

    private fun mergeTracks() {
        var i = 0
        while (i < tracks.size) {
            var j = i + 1
            while (j < tracks.size) {
                if (matches(tracks[i], tracks[j])) {
                    val keep = tracks[i]
                    val drop = tracks.removeAt(j)
                    absorb(keep, drop)
                    keep.hits = max(keep.hits, drop.hits)
                    keep.confidence = max(keep.confidence, drop.confidence)
                } else {
                    j++
                }
            }
            i++
        }
    }

    private class Corner(val x: Float, val z: Float)

    private fun build(floorY: Float, ceilingY: Float?): EdgeSnapshot {
        val shown = tracks.filter { it.confidence >= MIN_SHOWN }
        val confirmed = shown.filter { it.confirmed }
        val corners = ArrayList<Corner>()
        // For each shown wall: the corner index at each end, or -1.
        val endCorner = Array(shown.size) { intArrayOf(-1, -1) }
        val ends = Array(shown.size) { floatArrayOf(shown[it].ax(), shown[it].az(), shown[it].bx(), shown[it].bz()) }
        val cornerHeights = ArrayList<Float>()

        for (a in confirmed.indices) {
            for (b in a + 1 until confirmed.size) {
                val ta = confirmed[a]
                val tb = confirmed[b]
                val cos = abs(ta.dx * tb.dx + ta.dz * tb.dz)
                if (cos > COS_PARALLEL) continue
                val det = ta.dx * -tb.dz - ta.dz * -tb.dx
                if (abs(det) < 1e-4f) continue
                val rx = tb.px - ta.px
                val rz = tb.pz - ta.pz
                val sa = (rx * -tb.dz - rz * -tb.dx) / det
                val sb = (ta.dx * rz - ta.dz * rx) / det
                if (sa < ta.t0 - CORNER_REACH_M || sa > ta.t1 + CORNER_REACH_M) continue
                if (sb < tb.t0 - CORNER_REACH_M || sb > tb.t1 + CORNER_REACH_M) continue
                val cx = ta.px + ta.dx * sa
                val cz = ta.pz + ta.dz * sa
                val ci = corners.size
                corners.add(Corner(cx, cz))
                cornerHeights.add(min(ta.topY, tb.topY))
                val ia = shown.indexOf(ta)
                val ib = shown.indexOf(tb)
                snap(ta, sa, ia, ci, endCorner, ends, cx, cz)
                snap(tb, sb, ib, ci, endCorner, ends, cx, cz)
            }
        }

        val edges = ArrayList<LiveEdge>()
        val walls = ArrayList<LiveWall>()
        for (i in shown.indices) {
            val t = shown[i]
            val alpha = t.confidence.coerceIn(0f, 1f)
            val e = ends[i]
            edges.add(LiveEdge(EdgeKind.FLOOR_WALL, e[0], floorY, e[1], e[2], floorY, e[3], alpha))
            if (ceilingY != null) edges.add(LiveEdge(EdgeKind.WALL_CEILING, e[0], ceilingY, e[1], e[2], ceilingY, e[3], alpha))
            walls.add(LiveWall(e[0], e[1], e[2], e[3], ceilingY ?: max(t.topY, floorY + MIN_WALL_HEIGHT)))
        }
        for ((ci, c) in corners.withIndex()) {
            val top = ceilingY ?: max(cornerHeights[ci], floorY + MIN_WALL_HEIGHT)
            edges.add(LiveEdge(EdgeKind.CORNER, c.x, floorY, c.z, c.x, top, c.z, 1f))
        }
        val outline = outline(shown, endCorner, corners)
        return EdgeSnapshot(version, floorY, ceilingY, edges, walls, outline)
    }

    /** Snaps the end of [t] nearest corner parameter [s] to the corner, if the corner is at an end (not a T-junction). */
    private fun snap(t: Track, s: Float, index: Int, corner: Int, endCorner: Array<IntArray>, ends: Array<FloatArray>, cx: Float, cz: Float) {
        val toStart = abs(s - t.t0)
        val toEnd = abs(s - t.t1)
        if (min(toStart, toEnd) > CORNER_REACH_M) return
        val e = if (toStart <= toEnd) 0 else 1
        endCorner[index][e] = corner
        ends[index][e * 2] = cx
        ends[index][e * 2 + 1] = cz
    }

    /** Longest closed loop of walls joined end to end by corners, as x, z pairs; null when none encloses an area. */
    private fun outline(shown: List<Track>, endCorner: Array<IntArray>, corners: List<Corner>): FloatArray? {
        var best: FloatArray? = null
        var bestPerimeter = 0f
        for (start in shown.indices) {
            if (endCorner[start][0] < 0 || endCorner[start][1] < 0) continue
            val points = ArrayList<Int>()
            val used = HashSet<Int>()
            var wall = start
            var enterEnd = 0
            points.add(endCorner[start][0])
            var closed = false
            while (used.add(wall)) {
                val exit = 1 - enterEnd
                val c = endCorner[wall][exit]
                if (c < 0) break
                if (c == points[0]) {
                    closed = true
                    break
                }
                points.add(c)
                var next = -1
                var nextEnter = 0
                for (w in shown.indices) {
                    if (w == wall || w in used) continue
                    for (e in 0..1) if (endCorner[w][e] == c) {
                        next = w
                        nextEnter = e
                    }
                }
                if (next < 0) break
                wall = next
                enterEnd = nextEnter
            }
            if (!closed || points.size < 3) continue
            val xs = FloatArray(points.size * 2)
            for ((k, p) in points.withIndex()) {
                xs[k * 2] = corners[p].x
                xs[k * 2 + 1] = corners[p].z
            }
            val area = abs(signedArea(xs))
            if (area < MIN_OUTLINE_AREA_M2) continue
            var perimeter = 0f
            for (k in points.indices) {
                val n = (k + 1) % points.size
                perimeter += hypot(xs[k * 2] - xs[n * 2], xs[k * 2 + 1] - xs[n * 2 + 1])
            }
            if (perimeter > bestPerimeter) {
                bestPerimeter = perimeter
                best = xs
            }
        }
        return best
    }

    companion object {
        const val MIN_WALL_LENGTH = 0.4f
        const val MIN_WALL_HEIGHT = 0.5f
        const val MAX_ACROSS_M = 0.5f
        const val COS_MATCH = 0.99f // about 8 degrees
        const val COS_PARALLEL = 0.82f // corners need more than about 35 degrees
        const val MATCH_DIST_M = 0.15f
        const val MATCH_GAP_M = 0.3f
        const val CORNER_REACH_M = 0.4f
        const val CONFIRM_HITS = 3
        const val RISE = 0.34f
        const val FALL = 0.15f
        const val MIN_SHOWN = 0.3f
        const val SMOOTH = 0.3f
        const val MIN_OUTLINE_AREA_M2 = 1f

        fun signedArea(xz: FloatArray): Float {
            var s = 0f
            val n = xz.size / 2
            for (i in 0 until n) {
                val j = (i + 1) % n
                s += xz[i * 2] * xz[j * 2 + 1] - xz[j * 2] * xz[i * 2 + 1]
            }
            return s / 2f
        }

        /** Ear clipping of a simple polygon given as x, z pairs; returns vertex index triples. Empty when degenerate. */
        fun triangulate(xz: FloatArray): IntArray {
            val n = xz.size / 2
            if (n < 3) return IntArray(0)
            val idx = ArrayList<Int>((0 until n).toList())
            if (signedArea(xz) < 0f) idx.reverse()
            val out = ArrayList<Int>()
            var guard = 0
            while (idx.size > 3 && guard++ < n * n) {
                var clipped = false
                for (k in idx.indices) {
                    val a = idx[(k + idx.size - 1) % idx.size]
                    val b = idx[k]
                    val c = idx[(k + 1) % idx.size]
                    if (cross(xz, a, b, c) <= 1e-6f) continue
                    if (idx.any { it != a && it != b && it != c && inside(xz, it, a, b, c) }) continue
                    out.add(a); out.add(b); out.add(c)
                    idx.removeAt(k)
                    clipped = true
                    break
                }
                if (!clipped) return IntArray(0)
            }
            if (idx.size == 3) { out.add(idx[0]); out.add(idx[1]); out.add(idx[2]) }
            return out.toIntArray()
        }

        private fun cross(p: FloatArray, a: Int, b: Int, c: Int): Float =
            (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2])

        private fun inside(p: FloatArray, q: Int, a: Int, b: Int, c: Int): Boolean {
            val d1 = cross(p, a, b, q)
            val d2 = cross(p, b, c, q)
            val d3 = cross(p, c, a, q)
            return d1 >= 0f && d2 >= 0f && d3 >= 0f
        }
    }
}

/**
 * Runs [EdgeModel] on its own thread. [submit] never blocks and is dropped while a previous update is still running,
 * so the GL thread only pays for the plane snapshot. [snapshot] is read from the GL thread.
 */
class LiveEdges {
    private val model = EdgeModel()
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "live-edges").apply { isDaemon = true } }
    private val busy = AtomicBoolean(false)

    @Volatile
    var snapshot: EdgeSnapshot = EdgeSnapshot.EMPTY
        private set

    fun submit(planes: List<PlaneRecord>) {
        if (!busy.compareAndSet(false, true)) return
        executor.execute {
            try {
                snapshot = model.update(planes)
            } catch (e: Exception) {
                android.util.Log.w("LiveEdges", "Edge update failed", e)
            } finally {
                busy.set(false)
            }
        }
    }

    fun shutdown() = executor.shutdownNow()
}
