package com.faizmuttaqin.spatialstudio.scan.gl

import android.opengl.GLES20
import android.opengl.Matrix
import com.faizmuttaqin.spatialstudio.scan.CoverageGrid

/**
 * Draws the 25 cm floor grid on the floor in the camera view: covered cells as a faint green
 * tile, frontier cells (covered, next to floor not yet seen) as a brighter amber tile. The
 * vertex data is rebuilt only when the grid's version changes.
 */
class CoverageOverlay {
    private var program = 0
    private var positionAttrib = 0
    private var colorAttrib = 0
    private var mvpUniform = 0
    private var buffer = GlUtil.floatBuffer(FLOATS * 6 * 256)
    private var vertexCount = 0
    private var builtVersion = -1
    private val mvp = FloatArray(16)

    fun create() {
        program = GlUtil.program(VERTEX, FRAGMENT)
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position")
        colorAttrib = GLES20.glGetAttribLocation(program, "a_Color")
        mvpUniform = GLES20.glGetUniformLocation(program, "u_ModelViewProjection")
        builtVersion = -1
    }

    fun draw(grid: CoverageGrid, view: FloatArray, projection: FloatArray) {
        val floorY = grid.floorY ?: return
        if (grid.version != builtVersion) rebuild(grid, floorY)
        if (vertexCount == 0) return
        Matrix.multiplyMM(mvp, 0, projection, 0, view, 0)
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        GLES20.glUseProgram(program)
        GLES20.glUniformMatrix4fv(mvpUniform, 1, false, mvp, 0)
        buffer.position(0)
        GLES20.glVertexAttribPointer(positionAttrib, 3, GLES20.GL_FLOAT, false, FLOATS * 4, buffer)
        GLES20.glEnableVertexAttribArray(positionAttrib)
        buffer.position(3)
        GLES20.glVertexAttribPointer(colorAttrib, 4, GLES20.GL_FLOAT, false, FLOATS * 4, buffer)
        GLES20.glEnableVertexAttribArray(colorAttrib)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, vertexCount)
        GLES20.glDisableVertexAttribArray(positionAttrib)
        GLES20.glDisableVertexAttribArray(colorAttrib)
        GLES20.glDisable(GLES20.GL_BLEND)
        buffer.position(0)
    }

    private fun rebuild(grid: CoverageGrid, floorY: Float) {
        builtVersion = grid.version
        val (cells, frontier) = grid.cells()
        val needed = cells.size * 6 * FLOATS
        if (buffer.capacity() < needed) buffer = GlUtil.floatBuffer(needed)
        buffer.clear()
        val size = grid.cellMetres
        val inset = size * 0.04f
        val y = floorY + LIFT_M
        for (cell in cells) {
            val color = if (cell in frontier) FRONTIER else COVERED
            val x0 = CoverageGrid.cx(cell) * size + inset
            val z0 = CoverageGrid.cz(cell) * size + inset
            val x1 = x0 + size - 2 * inset
            val z1 = z0 + size - 2 * inset
            vertex(x0, y, z0, color); vertex(x1, y, z0, color); vertex(x1, y, z1, color)
            vertex(x0, y, z0, color); vertex(x1, y, z1, color); vertex(x0, y, z1, color)
        }
        vertexCount = cells.size * 6
        buffer.position(0)
    }

    private fun vertex(x: Float, y: Float, z: Float, c: FloatArray) {
        buffer.put(x); buffer.put(y); buffer.put(z)
        buffer.put(c[0]); buffer.put(c[1]); buffer.put(c[2]); buffer.put(c[3])
    }

    private companion object {
        const val FLOATS = 7
        const val LIFT_M = 0.01f
        val COVERED = floatArrayOf(0.2f, 0.85f, 0.4f, 0.22f)
        val FRONTIER = floatArrayOf(1f, 0.7f, 0.1f, 0.45f)
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
