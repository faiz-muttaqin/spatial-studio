package com.faizmuttaqin.spatialstudio.scan

import com.faizmuttaqin.spatialstudio.scan.CameraConfigChoice.Candidate
import org.junit.Assert.assertEquals
import org.junit.Test

class CameraConfigChoiceTest {
    @Test
    fun picksTheLargestCpuImageWithinTheLimit() {
        val list = listOf(Candidate(640, 480, 30), Candidate(1920, 1080, 30), Candidate(1280, 720, 30), Candidate(2560, 1440, 30))
        assertEquals(1, CameraConfigChoice.pick(list))
    }

    @Test
    fun prefersThirtyFpsAtEqualSize() {
        val list = listOf(Candidate(1280, 720, 60), Candidate(1280, 720, 24), Candidate(1280, 720, 30))
        assertEquals(0, CameraConfigChoice.pick(list))
        assertEquals(1, CameraConfigChoice.pick(listOf(Candidate(1280, 720, 24), Candidate(1280, 720, 30))))
    }

    @Test
    fun fallsBackToTheSmallestOversizedImage() {
        assertEquals(1, CameraConfigChoice.pick(listOf(Candidate(4000, 3000, 30), Candidate(2560, 1440, 30))))
        assertEquals(-1, CameraConfigChoice.pick(emptyList()))
    }
}
