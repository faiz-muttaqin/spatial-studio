package com.faizmuttaqin.spatialstudio.scan.gl

import android.opengl.GLES20
import android.opengl.Matrix
import com.faizmuttaqin.spatialstudio.scan.BasePoint
import com.faizmuttaqin.spatialstudio.scan.BoundaryKind
import com.faizmuttaqin.spatialstudio.scan.BoundaryMark

/** Draws marked boundaries (floor line, posts and top line) and the pending start point in world space. */
class LineOverlay {
    private var program = 0
    private var positionAttrib = 0
    private var colorAttrib = 0
    private var mvpUniform = 0
    private var buffer = GlUtil.floatBuffer(7 * 256)
    private var vertices = FloatArray(7 * 256)
    private var count = 0
    private val mvp = FloatArray(16)

    fun create() {
        program = GlUtil.program(VERTEX, FRAGMENT)
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position")
        colorAttrib = GLES20.glGetAttribLocation(program, "a_Color")
        mvpUniform = GLES20.glGetUniformLocation(program, "u_ModelViewProjection")
    }

    fun draw(marks: List<BoundaryMark>, pending: Pair<BoundaryKind, BasePoint>?, candidate: BasePoint?, view: FloatArray, projection: FloatArray) {
        count = 0
        for (m in marks) addMark(m)
        pending?.let { (kind, start) -> addCross(start, color(kind)) }
        // An unconfirmed tap: a large white cross until the user confirms or taps elsewhere.
        candidate?.let { addCross(it, CANDIDATE, 2f) }
        if (count == 0) return
        if (buffer.capacity() < count * FLOATS) buffer = GlUtil.floatBuffer(count * FLOATS)
        buffer.clear()
        buffer.put(vertices, 0, count * FLOATS)
        Matrix.multiplyMM(mvp, 0, projection, 0, view, 0)

        GLES20.glUseProgram(program)
        GLES20.glUniformMatrix4fv(mvpUniform, 1, false, mvp, 0)
        GLES20.glLineWidth(6f)
        buffer.position(0)
        GLES20.glVertexAttribPointer(positionAttrib, 3, GLES20.GL_FLOAT, false, FLOATS * 4, buffer)
        GLES20.glEnableVertexAttribArray(positionAttrib)
        buffer.position(3)
        GLES20.glVertexAttribPointer(colorAttrib, 4, GLES20.GL_FLOAT, false, FLOATS * 4, buffer)
        GLES20.glEnableVertexAttribArray(colorAttrib)
        GLES20.glDrawArrays(GLES20.GL_LINES, 0, count)
        GLES20.glDisableVertexAttribArray(positionAttrib)
        GLES20.glDisableVertexAttribArray(colorAttrib)
        buffer.position(0)
    }

    private fun addMark(m: BoundaryMark) {
        val c = color(m.kind)
        // Unknown height still gets short posts so the user can see where the ends are.
        val h = (m.height.metres ?: UNKNOWN_POST_HEIGHT_M).toFloat()
        val ax = m.start.x
        val ay = m.start.y
        val az = m.start.z
        val bx = m.end.x
        val by = m.end.y
        val bz = m.end.z
        line(ax, ay, az, bx, by, bz, c)
        line(ax, ay, az, ax, ay + h, az, c)
        line(bx, by, bz, bx, by + h, bz, c)
        if (m.height.metres != null) line(ax, ay + h, az, bx, by + h, bz, c)
    }

    private fun addCross(p: BasePoint, c: FloatArray, scale: Float = 1f) {
        val arm = ARM * scale
        line(p.x - arm, p.y, p.z, p.x + arm, p.y, p.z, c)
        line(p.x, p.y, p.z - arm, p.x, p.y, p.z + arm, c)
        line(p.x, p.y, p.z, p.x, p.y + UNKNOWN_POST_HEIGHT_M.toFloat(), p.z, c)
    }

    private fun line(x1: Float, y1: Float, z1: Float, x2: Float, y2: Float, z2: Float, c: FloatArray) {
        if ((count + 2) * FLOATS > vertices.size) vertices = vertices.copyOf(vertices.size * 2)
        put(x1, y1, z1, c)
        put(x2, y2, z2, c)
    }

    private fun put(x: Float, y: Float, z: Float, c: FloatArray) {
        val o = count * FLOATS
        vertices[o] = x
        vertices[o + 1] = y
        vertices[o + 2] = z
        vertices[o + 3] = c[0]
        vertices[o + 4] = c[1]
        vertices[o + 5] = c[2]
        vertices[o + 6] = c[3]
        count++
    }

    private fun color(kind: BoundaryKind): FloatArray = when (kind) {
        BoundaryKind.WALL -> WALL
        BoundaryKind.GLASS -> GLASS
        BoundaryKind.MIRROR -> MIRROR
        BoundaryKind.OPENING -> OPENING
        BoundaryKind.DOOR -> DOOR
    }

    private companion object {
        const val FLOATS = 7
        const val ARM = 0.12f
        const val UNKNOWN_POST_HEIGHT_M = 0.4
        val CANDIDATE = floatArrayOf(1f, 1f, 1f, 1f)
        val WALL = floatArrayOf(1f, 1f, 1f, 1f)
        val GLASS = floatArrayOf(0.3f, 0.8f, 1f, 1f)
        val MIRROR = floatArrayOf(1f, 0.4f, 0.9f, 1f)
        val OPENING = floatArrayOf(1f, 0.9f, 0.2f, 1f)
        val DOOR = floatArrayOf(1f, 0.6f, 0.15f, 1f)
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
