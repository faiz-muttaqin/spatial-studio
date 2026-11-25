package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.abs
import kotlin.math.hypot

/** What a boundary is. Wire names are the contract's `kind` values. */
enum class BoundaryKind(val wire: String, val usesCeilingHeight: Boolean) {
    WALL("wall", true),
    GLASS("glass", true),
    MIRROR("mirror", true),
    OPENING("opening", false),

    /** A door or opening is not ceiling height, so it never takes the ceiling plane. */
    DOOR("door", false),
}

enum class HeightSource(val wire: String) {
    CEILING_PLANE("ceiling-plane"),
    TYPED("typed"),
    UNKNOWN("unknown"),
}

/** The kind of trackable an ARCore hit-test result landed on. */
enum class HitKind { HORIZONTAL_UP_PLANE, HORIZONTAL_DOWN_PLANE, VERTICAL_PLANE, FEATURE_POINT, DEPTH_POINT, INSTANT_PLACEMENT, OTHER }

/** One hit-test result, in ARCore's order (nearest first). */
class HitCandidate(
    val kind: HitKind,
    /** `Plane.isPoseInPolygon` for plane hits; false otherwise. */
    val inPolygon: Boolean,
    val tracking: Boolean,
    val distanceM: Float,
    /** Column-major hit pose. */
    val pose: FloatArray,
    val planeId: String?,
) {
    val y: Float get() = pose[13]

    /** Y axis of the hit pose (ARCore: the plane normal) pointing up in the gravity-aligned world. */
    val normalY: Float get() = pose[5]
}

enum class Refusal { NO_HIT, NOT_TRACKING, NOT_FLOOR, OBSTRUCTED, ABOVE_FLOOR, OUT_OF_RANGE }

sealed interface HitDecision {
    class Accepted(val hit: HitCandidate) : HitDecision
    class Refused(val reason: Refusal) : HitDecision
}

/** Horizontal-plane summary used for floor level and ceiling picks. */
class PlaneSummary(
    val id: String,
    val kind: HitKind,
    val tracking: Boolean,
    val centerY: Float,
    val extentX: Float,
    val extentZ: Float,
) {
    val area: Float get() = extentX * extentZ
}

object BoundaryMarking {
    /** A floor line needs a floor plane that is more than a speck. */
    const val MIN_FLOOR_PLANE_AREA_M2 = 0.25f
    const val FLOOR_TOLERANCE_M = 0.25f
    const val MIN_HIT_DISTANCE_M = 0.2f
    const val MAX_HIT_DISTANCE_M = 8f

    /** A depth or feature point this much nearer than the floor hit is the floor's own noise, not an obstacle. */
    const val OBSTRUCTION_MARGIN_M = 0.08f
    const val MIN_NORMAL_Y = 0.9f

    const val MIN_LENGTH_M = 0.05
    const val MAX_LENGTH_M = 50.0
    const val MAX_BASE_SLOPE_M = 0.5
    const val MAX_MARKS = 200
    const val MIN_HEIGHT_M = 0.1
    const val MAX_HEIGHT_M = 10.0
    const val MIN_CEILING_HEIGHT_M = 1.8
    const val MAX_CEILING_HEIGHT_M = 6.0

    /** Lowest tracked upward plane of useful size, or null when none is known yet. */
    fun floorY(planes: List<PlaneSummary>): Float? = planes
        .filter { it.kind == HitKind.HORIZONTAL_UP_PLANE && it.tracking && it.area >= MIN_FLOOR_PLANE_AREA_M2 }
        .minOfOrNull { it.centerY }

    /**
     * Decides whether a tap is a usable floor point. Only a tracked, upward horizontal plane hit inside its
     * polygon at floor level qualifies. Feature points and depth points are refused when they are nearer than the
     * floor hit (on clear glass they land on whatever lies behind it, or on the glass itself), and so is any
     * vertical or ceiling plane in front of the floor.
     */
    fun chooseFloorHit(candidates: List<HitCandidate>, floorY: Float?): HitDecision {
        if (candidates.isEmpty()) return HitDecision.Refused(Refusal.NO_HIT)
        val floor = candidates.firstOrNull { it.kind == HitKind.HORIZONTAL_UP_PLANE && it.inPolygon && it.normalY >= MIN_NORMAL_Y }
            ?: return HitDecision.Refused(Refusal.NOT_FLOOR)
        if (!floor.tracking) return HitDecision.Refused(Refusal.NOT_TRACKING)
        if (candidates.any { it !== floor && it.distanceM < floor.distanceM - OBSTRUCTION_MARGIN_M }) {
            return HitDecision.Refused(Refusal.OBSTRUCTED)
        }
        if (floor.distanceM < MIN_HIT_DISTANCE_M || floor.distanceM > MAX_HIT_DISTANCE_M) {
            return HitDecision.Refused(Refusal.OUT_OF_RANGE)
        }
        if (floorY != null && floor.y > floorY + FLOOR_TOLERANCE_M) return HitDecision.Refused(Refusal.ABOVE_FLOOR)
        return HitDecision.Accepted(floor)
    }

    class CeilingPick(val heightM: Double, val planeId: String)

    /**
     * Height of the biggest tracked downward-facing plane above [baseY], if it lies in the ceiling range.
     * Larger planes win because a lamp or soffit gives small, lower planes.
     */
    fun ceilingHeight(baseY: Double, planes: List<PlaneSummary>): CeilingPick? = planes
        .filter { it.kind == HitKind.HORIZONTAL_DOWN_PLANE && it.tracking }
        .filter { (it.centerY - baseY) in MIN_CEILING_HEIGHT_M..MAX_CEILING_HEIGHT_M }
        .maxByOrNull { it.area }
        ?.let { CeilingPick(it.centerY - baseY, it.id) }

    /** Metres from text; accepts a decimal comma. Null when empty, not a number or outside the contract range. */
    fun parseTypedHeight(text: String?): Double? {
        val value = text?.trim()?.replace(',', '.')?.takeIf { it.isNotEmpty() }?.toDoubleOrNull() ?: return null
        return value.takeIf { it.isFinite() && it in MIN_HEIGHT_M..MAX_HEIGHT_M }
    }

    class HeightChoice(val metres: Double?, val source: HeightSource, val ceilingPlaneId: String?)

    /** A typed height wins; otherwise the ceiling plane, only for kinds that stand floor to ceiling. */
    fun resolveHeight(kind: BoundaryKind, typedM: Double?, baseY: Double, planes: List<PlaneSummary>): HeightChoice {
        if (typedM != null) return HeightChoice(typedM, HeightSource.TYPED, null)
        if (kind.usesCeilingHeight) {
            ceilingHeight(baseY, planes)?.let { return HeightChoice(it.heightM, HeightSource.CEILING_PLANE, it.planeId) }
        }
        return HeightChoice(null, HeightSource.UNKNOWN, null)
    }

    fun horizontalDistance(a: BasePoint, b: BasePoint): Double =
        hypot((a.x - b.x).toDouble(), (a.z - b.z).toDouble())

    fun mean(a: Double, b: Double) = (a + b) / 2

    fun slope(a: BasePoint, b: BasePoint): Double = abs((a.y - b.y).toDouble())
}

/** A tapped floor point: world metres, the hit pose and the frame it was resolved against. */
class BasePoint(
    val pose: FloatArray,
    val planeId: String?,
    val timestampNs: Long,
) {
    val x: Float get() = pose[12]
    val y: Float get() = pose[13]
    val z: Float get() = pose[14]
}

class BoundaryMark(
    val id: String,
    val kind: BoundaryKind,
    val start: BasePoint,
    val end: BasePoint,
    val height: BoundaryMarking.HeightChoice,
    val createdAtMs: Long,
)

/** Marks made during a scan, plus the pending start point. Touched from the UI and GL threads. */
class BoundaryMarkBook {
    sealed interface Result {
        class Started(val kind: BoundaryKind) : Result
        class Completed(val mark: BoundaryMark) : Result
        object TooShort : Result
        object TooLong : Result
        object TooSteep : Result
        object Full : Result
    }

    private val marks = ArrayList<BoundaryMark>()
    private var pendingKind: BoundaryKind? = null
    private var pendingStart: BasePoint? = null

    @Synchronized
    fun snapshot(): List<BoundaryMark> = marks.toList()

    @Synchronized
    fun pending(): Pair<BoundaryKind, BasePoint>? = pendingStart?.let { pendingKind!! to it }

    @Synchronized
    fun count(): Int = marks.size

    /**
     * The first tap starts a mark of [kind]; the second completes it. [height] is only called for the second tap,
     * with the kind chosen at the first tap and the mean base height, so the caller resolves it against the planes tracked right then.
     */
    @Synchronized
    fun tap(kind: BoundaryKind, point: BasePoint, nowMs: Long, height: (kind: BoundaryKind, baseY: Double) -> BoundaryMarking.HeightChoice): Result {
        val start = pendingStart
        val startKind = pendingKind
        if (start == null || startKind == null) {
            if (marks.size >= BoundaryMarking.MAX_MARKS) return Result.Full
            pendingStart = point
            pendingKind = kind
            return Result.Started(kind)
        }
        val length = BoundaryMarking.horizontalDistance(start, point)
        if (length < BoundaryMarking.MIN_LENGTH_M) return Result.TooShort
        if (length > BoundaryMarking.MAX_LENGTH_M) return Result.TooLong
        if (BoundaryMarking.slope(start, point) > BoundaryMarking.MAX_BASE_SLOPE_M) return Result.TooSteep
        val choice = height(startKind, BoundaryMarking.mean(start.y.toDouble(), point.y.toDouble()))
        val mark = BoundaryMark("mark-%03d".format(java.util.Locale.ROOT, marks.size + 1), startKind, start, point, choice, nowMs)
        marks.add(mark)
        pendingStart = null
        pendingKind = null
        return Result.Completed(mark)
    }

    /** Drops the pending start point, or when there is none, the last mark. Returns false when there was nothing. */
    @Synchronized
    fun undo(): Boolean {
        if (pendingStart != null) {
            pendingStart = null
            pendingKind = null
            return true
        }
        return marks.removeLastOrNull() != null
    }
}
