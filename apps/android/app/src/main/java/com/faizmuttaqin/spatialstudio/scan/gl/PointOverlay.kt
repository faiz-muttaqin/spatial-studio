package com.faizmuttaqin.spatialstudio.scan.gl

import android.opengl.GLES20
import android.opengl.Matrix

/** Draws the current frame's ARCore feature points so the user sees what is being tracked. */
class PointOverlay {
    private var program = 0
    private var positionAttrib = 0
    private var mvpUniform = 0
    private var buffer = GlUtil.floatBuffer(4 * 1024)
    private val mvp = FloatArray(16)

    fun create() {
        program = GlUtil.program(VERTEX, FRAGMENT)
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position")
        mvpUniform = GLES20.glGetUniformLocation(program, "u_ModelViewProjection")
    }

    /** [points] are packed `x, y, z, confidence` quadruples in world space. */
    fun draw(points: FloatArray, count: Int, view: FloatArray, projection: FloatArray) {
        if (count == 0) return
        if (buffer.capacity() < count * 4) buffer = GlUtil.floatBuffer(count * 4)
        buffer.clear()
        buffer.put(points, 0, count * 4)
        buffer.position(0)
        Matrix.multiplyMM(mvp, 0, projection, 0, view, 0)

        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        GLES20.glUseProgram(program)
        GLES20.glUniformMatrix4fv(mvpUniform, 1, false, mvp, 0)
        GLES20.glVertexAttribPointer(positionAttrib, 4, GLES20.GL_FLOAT, false, 16, buffer)
        GLES20.glEnableVertexAttribArray(positionAttrib)
        GLES20.glDrawArrays(GLES20.GL_POINTS, 0, count)
        GLES20.glDisableVertexAttribArray(positionAttrib)
        GLES20.glDisable(GLES20.GL_BLEND)
    }

    private companion object {
        const val VERTEX = """
            uniform mat4 u_ModelViewProjection;
            attribute vec4 a_Position;
            varying float v_Confidence;
            void main() {
                v_Confidence = a_Position.w;
                gl_Position = u_ModelViewProjection * vec4(a_Position.xyz, 1.0);
                gl_PointSize = 6.0;
            }
        """
        const val FRAGMENT = """
            precision mediump float;
            varying float v_Confidence;
            void main() {
                gl_FragColor = vec4(0.25, 0.85, 1.0, clamp(v_Confidence, 0.35, 1.0));
            }
        """
    }
}
