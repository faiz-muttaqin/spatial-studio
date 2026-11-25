package com.faizmuttaqin.spatialstudio.scan.gl

import android.opengl.GLES20
import android.opengl.Matrix
import com.faizmuttaqin.spatialstudio.scan.EdgeModel
import com.faizmuttaqin.spatialstudio.scan.EdgeSnapshot
import java.nio.FloatBuffer
import kotlin.math.hypot

/**
 * Live edge lines on the camera view and a small dollhouse of the room built so far. Vertex data is rebuilt only
 * when a new [EdgeSnapshot] arrives (a few times a second), so a frame costs two matrix products and two draws.
 * The lines are not depth-tested against the ARCore depth image.
 */
class EdgeOverlay {
    private class Batch {
        var buffer: FloatBuffer = GlUtil.floatBuffer(FLOATS * 256)
        var data = FloatArray(FLOATS * 256)
        var count = 0

        fun clear() { count = 0 }

        fun put(x: Float, y: Float, z: Float, r: Float, g: Float, b: Float, a: Float) {
            val o = count * FLOATS
            if (o + FLOATS > data.size) data = data.copyOf(data.size * 2)
            data[o] = x; data[o + 1] = y; data[o + 2] = z
            data[o + 3] = r; data[o + 4] = g; data[o + 5] = b; data[o + 6] = a
            count++
        }

        fun line(ax: Float, ay: Float, az: Float, bx: Float, by: Float, bz: Float, a: Float) {
            put(ax, ay, az, 1f, 1f, 1f, a)
            put(bx, by, bz, 1f, 1f, 1f, a)
        }

        fun upload() {
            if (buffer.capacity() < count * FLOATS) buffer = GlUtil.floatBuffer(data.size)
            buffer.clear()
            buffer.put(data, 0, count * FLOATS)
            buffer.position(0)
        }
    }

    private var program = 0
    private var positionAttrib = 0
    private var colorAttrib = 0
    private var mvpUniform = 0
    private val edgeLines = Batch()
    private val houseLines = Batch()
    private val houseFaces = Batch()
    private var builtVersion = -1L
    private val mvp = FloatArray(16)
    private val viewProjection = FloatArray(16)
    private val model = FloatArray(16)

    private var anchorX = 0f
    private var anchorZ = 0f
    private var anchored = false
    private var centerX = 0f
    private var centerZ = 0f
    private var boundsX = 0f
    private var boundsZ = 0f
    private var outOfViewSinceNs = 0L
    private var floorY = 0f

    fun create() {
        program = GlUtil.program(VERTEX, FRAGMENT)
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position")
        colorAttrib = GLES20.glGetAttribLocation(program, "a_Color")
        mvpUniform = GLES20.glGetUniformLocation(program, "u_ModelViewProjection")
        builtVersion = -1
    }

    /**
     * [cameraPose] is the camera-to-world matrix, used to place the dollhouse in front of the user once and again
     * when they have walked well away from it.
     */
    fun draw(snapshot: EdgeSnapshot, showModel: Boolean, cameraPose: FloatArray, view: FloatArray, projection: FloatArray) {
        if (snapshot.floorY == null || snapshot.edges.isEmpty()) return
        if (snapshot.version != builtVersion) rebuild(snapshot)
        Matrix.multiplyMM(viewProjection, 0, projection, 0, view, 0)
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        GLES20.glUseProgram(program)
        GLES20.glLineWidth(EDGE_WIDTH)
        drawBatch(edgeLines, GLES20.GL_LINES, viewProjection)
        if (showModel && houseLines.count > 0) {
            placeModel(cameraPose)
            Matrix.multiplyMM(mvp, 0, viewProjection, 0, model, 0)
            GLES20.glLineWidth(MODEL_WIDTH)
            // Faces without depth writes so the base lines at the same coordinates are never hidden by them.
            GLES20.glDepthMask(false)
            drawBatch(houseFaces, GLES20.GL_TRIANGLES, mvp)
            GLES20.glDepthMask(true)
            drawBatch(houseLines, GLES20.GL_LINES, mvp)
        }
        GLES20.glDisable(GLES20.GL_BLEND)
    }

    private fun drawBatch(batch: Batch, mode: Int, matrix: FloatArray) {
        if (batch.count == 0) return
        GLES20.glUniformMatrix4fv(mvpUniform, 1, false, matrix, 0)
        batch.buffer.position(0)
        GLES20.glVertexAttribPointer(positionAttrib, 3, GLES20.GL_FLOAT, false, FLOATS * 4, batch.buffer)
        GLES20.glEnableVertexAttribArray(positionAttrib)
        batch.buffer.position(3)
        GLES20.glVertexAttribPointer(colorAttrib, 4, GLES20.GL_FLOAT, false, FLOATS * 4, batch.buffer)
        GLES20.glEnableVertexAttribArray(colorAttrib)
        GLES20.glDrawArrays(mode, 0, batch.count)
        GLES20.glDisableVertexAttribArray(positionAttrib)
        GLES20.glDisableVertexAttribArray(colorAttrib)
        batch.buffer.position(0)
    }

    /**
     * The model sits on the floor about [DISTANCE_M] ahead of the user at 1:20. Its anchor and centre stay fixed
     * (so it does not slide while the room grows) until the user walks [REANCHOR_M] away or has had it out of view
     * for [OUT_OF_VIEW_NS]; it is then placed again in front of them.
     */
    private fun placeModel(cameraPose: FloatArray) {
        val camX = cameraPose[12]
        val camZ = cameraPose[14]
        var fx = -cameraPose[8]
        var fz = -cameraPose[10]
        val flen = hypot(fx, fz)
        val facing = flen >= 0.2f
        if (facing) { fx /= flen; fz /= flen }
        var reanchor = !anchored || hypot(camX - anchorX, camZ - anchorZ) > REANCHOR_M
        if (!reanchor && facing) {
            val dx = anchorX - camX
            val dz = anchorZ - camZ
            val dist = hypot(dx, dz)
            val inView = dist < 0.01f || (dx * fx + dz * fz) / dist >= IN_VIEW_COS
            val now = System.nanoTime()
            if (inView) {
                outOfViewSinceNs = 0L
            } else {
                if (outOfViewSinceNs == 0L) outOfViewSinceNs = now
                if (now - outOfViewSinceNs > OUT_OF_VIEW_NS) reanchor = true
            }
        }
        if (reanchor) {
            if (!facing) { fx = 0f; fz = -1f }
            anchorX = camX + fx * DISTANCE_M
            anchorZ = camZ + fz * DISTANCE_M
            centerX = boundsX
            centerZ = boundsZ
            anchored = true
            outOfViewSinceNs = 0L
        }
        Matrix.setIdentityM(model, 0)
        Matrix.translateM(model, 0, anchorX, floorY, anchorZ)
        Matrix.scaleM(model, 0, SCALE, SCALE, SCALE)
        Matrix.translateM(model, 0, -centerX, -floorY, -centerZ)
    }

    private fun rebuild(s: EdgeSnapshot) {
        builtVersion = s.version
        floorY = s.floorY ?: 0f
        edgeLines.clear()
        houseLines.clear()
        houseFaces.clear()
        for (e in s.edges) edgeLines.line(e.ax, e.ay, e.az, e.bx, e.by, e.bz, e.alpha)
        edgeLines.upload()

        if (s.walls.isEmpty()) return
        var minX = Float.MAX_VALUE; var maxX = -Float.MAX_VALUE
        var minZ = Float.MAX_VALUE; var maxZ = -Float.MAX_VALUE
        for (w in s.walls) {
            minX = minOf(minX, w.ax, w.bx); maxX = maxOf(maxX, w.ax, w.bx)
            minZ = minOf(minZ, w.az, w.bz); maxZ = maxOf(maxZ, w.az, w.bz)
        }
        boundsX = (minX + maxX) / 2
        boundsZ = (minZ + maxZ) / 2
        val fy = floorY + LIFT_M
        s.outline?.let { xz ->
            val tri = EdgeModel.triangulate(xz)
            for (i in tri) houseFaces.put(xz[i * 2], fy, xz[i * 2 + 1], 0.55f, 0.85f, 1f, FLOOR_ALPHA)
        }
        for (w in s.walls) {
            val top = w.topY
            quad(houseFaces, w.ax, w.az, w.bx, w.bz, fy, top)
            houseLines.line(w.ax, fy, w.az, w.bx, fy, w.bz, 1f)
            houseLines.line(w.ax, top, w.az, w.bx, top, w.bz, 0.8f)
            houseLines.line(w.ax, fy, w.az, w.ax, top, w.az, 0.8f)
            houseLines.line(w.bx, fy, w.bz, w.bx, top, w.bz, 0.8f)
        }
        houseFaces.upload()
        houseLines.upload()
    }

    private fun quad(b: Batch, ax: Float, az: Float, bx: Float, bz: Float, y0: Float, y1: Float) {
        b.put(ax, y0, az, 1f, 1f, 1f, WALL_ALPHA); b.put(bx, y0, bz, 1f, 1f, 1f, WALL_ALPHA); b.put(bx, y1, bz, 1f, 1f, 1f, WALL_ALPHA)
        b.put(ax, y0, az, 1f, 1f, 1f, WALL_ALPHA); b.put(bx, y1, bz, 1f, 1f, 1f, WALL_ALPHA); b.put(ax, y1, az, 1f, 1f, 1f, WALL_ALPHA)
    }

    private companion object {
        const val FLOATS = 7
        const val EDGE_WIDTH = 3f
        const val MODEL_WIDTH = 2f
        const val SCALE = 1f / 20f
        const val DISTANCE_M = 0.9f
        const val REANCHOR_M = 3f
        const val IN_VIEW_COS = 0.5f
        const val OUT_OF_VIEW_NS = 1_500_000_000L
        const val LIFT_M = 0.01f
        const val WALL_ALPHA = 0.16f
        const val FLOOR_ALPHA = 0.35f
        const val VERTEX = """
            uniform mat4 u_ModelViewProjection;
            attribute vec3 a_Position;
            attribute vec4 a_Color;
            varying vec4 v_Color;
            void main() {
                v_Color = a_Color;
                gl_Position = u_ModelViewProjection * vec4(a_Position, 1.0);
            }
        """
        const val FRAGMENT = """
            precision mediump float;
            varying vec4 v_Color;
            void main() {
                gl_FragColor = v_Color;
            }
        """
    }
}
