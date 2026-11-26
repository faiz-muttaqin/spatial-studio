package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Taps on the scan screen's overlays must not reach the camera surface, where a tap places a boundary mark. The
 * overlays are the containers and chips that cover it; each must consume touches.
 */
class ScanLayoutTest {
    private val layout = File("src/main/res/layout/activity_scan.xml").readText()

    /** The XML element that declares [id], from its opening tag to the first `>`. */
    private fun element(id: String): String {
        val at = layout.indexOf("@+id/$id\"")
        require(at >= 0) { "No view $id" }
        val start = layout.lastIndexOf('<', at)
        return layout.substring(start, layout.indexOf('>', at))
    }

    @Test
    fun overlaysConsumeTouchesSoTheySwallowNoMarks() {
        for (id in listOf("scan_bar", "scan_info_card", "scan_mark_panel", "scan_resume_card", "scan_guidance", "scan_counter", "scan_floor_chip", "scan_live")) {
            assertTrue("$id must be clickable so a tap on it does not mark the floor behind it", element(id).contains("android:clickable=\"true\""))
        }
    }

    @Test
    fun theCameraSurfaceItselfIsNotClickableSoMarkingGetsItsTaps() {
        assertTrue(!element("scan_surface").contains("android:clickable=\"true\""))
    }

    @Test
    fun touchTargetsAreAtLeast48dp() {
        val themes = File("src/main/res/values/themes.xml").readText()
        assertTrue(themes.contains("<item name=\"android:layout_width\">48dp</item>"))
        assertTrue(themes.contains("<item name=\"android:layout_height\">48dp</item>"))
        for (id in listOf("scan_mark_undo", "scan_mark_ceiling", "scan_resume")) {
            assertTrue("$id needs minHeight 48dp", element(id).contains("android:minHeight=\"48dp\""))
        }
    }
}
