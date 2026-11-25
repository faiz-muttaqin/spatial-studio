package com.faizmuttaqin.spatialstudio.scan

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.text.Editable
import android.text.TextWatcher
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.faizmuttaqin.spatialstudio.BuildConfig
import com.faizmuttaqin.spatialstudio.R
import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import com.faizmuttaqin.spatialstudio.bridge.NativeBridge
import com.faizmuttaqin.spatialstudio.capabilities.CapabilityProbe
import com.faizmuttaqin.spatialstudio.scan.gl.CameraBackground
import com.faizmuttaqin.spatialstudio.scan.gl.LineOverlay
import com.faizmuttaqin.spatialstudio.scan.gl.PointOverlay
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.DepthPoint
import com.google.ar.core.Frame
import com.google.ar.core.InstantPlacementPoint
import com.google.ar.core.Plane
import com.google.ar.core.Point
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.SessionPausedException
import com.google.ar.core.exceptions.UnsupportedConfigurationException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/**
 * Native ARCore scan screen. Runs only while visible: the camera stops on
 * pause, and leaving with Back or Cancel discards the partial scan.
 */
class ScanActivity : ComponentActivity(), GLSurfaceView.Renderer {

    private enum class Phase { STARTING, SCANNING, FINALIZING, DONE }

    private lateinit var scan: ScanCoordinator.ActiveScan
    private lateinit var store: ScanStore
    private lateinit var surface: GLSurfaceView
    private lateinit var statusText: TextView
    private lateinit var statsText: TextView
    private lateinit var hintText: TextView
    private lateinit var finishButton: Button
    private lateinit var cancelButton: Button
    private lateinit var sensorsText: TextView
    private lateinit var sensorsToggle: CheckBox
    private lateinit var locationToggle: CheckBox
    private lateinit var markToggle: Button
    private lateinit var markPanel: View
    private lateinit var markStatus: TextView
    private lateinit var markKind: Spinner
    private lateinit var markHeight: EditText
    private lateinit var markUndo: Button
    private lateinit var markConfirm: Button
    private lateinit var markCeiling: CheckBox

    // Assisted boundary marking (v1.2). Marks live here; the GL thread resolves taps against ARCore.
    private val marks = BoundaryMarkBook()
    @Volatile private var marking = false
    @Volatile private var markKindSelected = BoundaryKind.WALL
    @Volatile private var heightText = ""
    @Volatile private var toCeiling = true
    private val pendingTap = AtomicReference<FloatArray?>(null)
    private val confirmRequested = java.util.concurrent.atomic.AtomicBoolean(false)

    /** A tapped floor point waiting for Confirm; shown in the camera view. */
    @Volatile private var candidate: BasePoint? = null

    @Volatile private var phase = Phase.STARTING
    private var session: Session? = null
    private var recorder: ScanRecorder? = null
    private var capabilities: JsonObject? = null
    private var capabilitiesProbedAtMs = 0L
    private var cameraConfigJson: JsonObject = JsonObject(emptyMap())
    private var sensorOrientationDeg: Int? = null
    @Volatile private var pendingLightMode: Config.LightEstimationMode? = null
    private var locationDeclined = false
    private var locationDialogShown = false
    private var locationConfirmed = false
    private var sensorRecorder: SensorRecorder? = null
    private var lightMode = Config.LightEstimationMode.DISABLED
    private var locationRequested = false
    private var locationDenied = false
    private var updatingToggles = false
    private val headingPose = FloatArray(16)
    private var installRequested = false
    private var permissionRequested = false
    private var createdAtMs = 0L
    private var startedAtElapsed = 0L

    private val background = CameraBackground()
    private val overlay = PointOverlay()
    private val lines = LineOverlay()
    private var textureBound = false
    private var viewportWidth = 0
    private var viewportHeight = 0
    @Volatile private var displayGeometryDirty = false
    private val progressGate = IntervalGate(PROGRESS_INTERVAL_NS)
    private val view = FloatArray(16)
    private val projection = FloatArray(16)
    private val finalizer = Executors.newSingleThreadExecutor()

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) fail(BridgeErrorCode.PERMISSION_DENIED, getString(R.string.scan_camera_denied))
    }

    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) {
            locationDenied = true
            Toast.makeText(this, R.string.scan_location_denied, Toast.LENGTH_LONG).show()
        }
        // Before the session exists, createSession reads the permission state on the next resume.
        sensorRecorder?.let { recorder ->
            recorder.setLocationEnabled(granted)
            setToggles(recorder)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
        val active = ScanCoordinator.active
        if (sessionId == null || active == null || active.sessionId != sessionId || !ScanCoordinator.markStarted(sessionId)) {
            // Stale launch (process restarted, or the start watchdog already gave up): nothing to scan for.
            // Releasing is a no-op unless this launch still holds the scan.
            sessionId?.let(ScanCoordinator::end)
            finish()
            return
        }
        scan = active
        store = ScanStore(scansRoot(this))
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_scan)

        surface = ActivityCompat.requireViewById(this, R.id.scan_surface)
        statusText = ActivityCompat.requireViewById(this, R.id.scan_status)
        statsText = ActivityCompat.requireViewById(this, R.id.scan_stats)
        hintText = ActivityCompat.requireViewById(this, R.id.scan_hint)
        finishButton = ActivityCompat.requireViewById(this, R.id.scan_finish)
        cancelButton = ActivityCompat.requireViewById(this, R.id.scan_cancel)
        sensorsText = ActivityCompat.requireViewById(this, R.id.scan_sensors)
        sensorsToggle = ActivityCompat.requireViewById(this, R.id.scan_toggle_sensors)
        locationToggle = ActivityCompat.requireViewById(this, R.id.scan_toggle_location)
        markToggle = ActivityCompat.requireViewById(this, R.id.scan_mark_toggle)
        markPanel = ActivityCompat.requireViewById(this, R.id.scan_mark_panel)
        markStatus = ActivityCompat.requireViewById(this, R.id.scan_mark_status)
        markKind = ActivityCompat.requireViewById(this, R.id.scan_mark_kind)
        markHeight = ActivityCompat.requireViewById(this, R.id.scan_mark_height)
        markUndo = ActivityCompat.requireViewById(this, R.id.scan_mark_undo)
        markConfirm = ActivityCompat.requireViewById(this, R.id.scan_mark_confirm)
        markCeiling = ActivityCompat.requireViewById(this, R.id.scan_mark_ceiling)
        setUpMarking()
        sensorsToggle.setOnCheckedChangeListener { _, checked ->
            if (updatingToggles) return@setOnCheckedChangeListener
            sensorRecorder?.setSensorsEnabled(checked)
            recorder?.setLightEnabled(checked, lightMode)
            // ARCore stops estimating light too; applied on the GL thread before the next frame.
            pendingLightMode = if (checked) lightMode else Config.LightEstimationMode.DISABLED
            if (!checked) sensorsText.setText(R.string.scan_sensors_off)
        }
        locationToggle.setOnCheckedChangeListener { _, checked ->
            if (updatingToggles) return@setOnCheckedChangeListener
            val sensors = sensorRecorder ?: return@setOnCheckedChangeListener
            if (checked && !sensors.hasLocationPermission()) {
                locationPermission.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
            } else {
                sensors.setLocationEnabled(checked)
            }
        }

        val hud = ActivityCompat.requireViewById<View>(this, R.id.scan_hud)
        val controls = ActivityCompat.requireViewById<View>(this, R.id.scan_controls)
        ViewCompat.setOnApplyWindowInsetsListener(ActivityCompat.requireViewById(this, R.id.scan_root)) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            hud.setPadding(hud.paddingLeft, bars.top + PADDING_PX, hud.paddingRight, hud.paddingBottom)
            controls.setPadding(controls.paddingLeft, controls.paddingTop, controls.paddingRight, bars.bottom + PADDING_PX)
            insets
        }

        surface.preserveEGLContextOnPause = true
        surface.setEGLContextClientVersion(2)
        surface.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        surface.setRenderer(this)
        surface.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        surface.setWillNotDraw(false)

        finishButton.setOnClickListener { finishScan() }
        cancelButton.setOnClickListener { cancelScan() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = cancelScan()
            },
        )
        ScanCoordinator.state(scan.sessionId, "starting")
    }

    override fun onResume() {
        super.onResume()
        tryStart()
    }

    private fun tryStart() {
        if (phase == Phase.DONE || phase == Phase.FINALIZING || !::scan.isInitialized) return
        if (session == null && !createSession()) return
        try {
            session?.resume()
        } catch (e: CameraNotAvailableException) {
            fail(BridgeErrorCode.BUSY, getString(R.string.scan_camera_busy))
            return
        } catch (e: SecurityException) {
            fail(BridgeErrorCode.PERMISSION_DENIED, getString(R.string.scan_camera_denied))
            return
        }
        surface.onResume()
        displayGeometryDirty = true
        if (phase == Phase.STARTING) {
            phase = Phase.SCANNING
            startedAtElapsed = SystemClock.elapsedRealtime()
            finishButton.isEnabled = true
            markToggle.isEnabled = true
        }
        sensorRecorder?.start()
        ScanCoordinator.state(scan.sessionId, "scanning")
    }

    override fun onPause() {
        super.onPause()
        if (!::scan.isInitialized) return
        // Stop rendering first, then release the camera. No capture continues in the background.
        surface.onPause()
        sensorRecorder?.stop()
        session?.pause()
        if (phase == Phase.SCANNING && !isFinishing) ScanCoordinator.state(scan.sessionId, "paused")
    }

    override fun onDestroy() {
        if (::scan.isInitialized && phase != Phase.DONE && phase != Phase.FINALIZING) {
            // Destroyed without Finish (for example the system reclaimed the screen): discard.
            discardPartial("cancelled", null)
        }
        sensorRecorder?.stop()
        session?.close()
        session = null
        finalizer.shutdown()
        super.onDestroy()
    }

    /** Creates and configures the ARCore session. Returns false when it must wait or failed. */
    private fun createSession(): Boolean {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            if (!permissionRequested) {
                permissionRequested = true
                cameraPermission.launch(Manifest.permission.CAMERA)
            }
            return false
        }
        if (scan.options.location && !locationConfirmed && !locationDeclined) {
            confirmLocation()
            return false
        }
        if (scan.options.location && !locationDeclined && !locationRequested &&
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            // Only on the page's opt-in, and only the approximate permission: sun and declination need kilometres.
            locationRequested = true
            locationPermission.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
            return false
        }
        try {
            when (ArCoreApk.getInstance().requestInstall(this, !installRequested)) {
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
                    installRequested = true
                    return false
                }
                ArCoreApk.InstallStatus.INSTALLED -> Unit
            }
        } catch (e: UnavailableUserDeclinedInstallationException) {
            fail(BridgeErrorCode.UNSUPPORTED, "ARCore installation was declined")
            return false
        } catch (e: UnavailableDeviceNotCompatibleException) {
            fail(BridgeErrorCode.UNSUPPORTED, getString(R.string.scan_arcore_unavailable))
            return false
        } catch (e: Exception) {
            // For example no Play Store to install Google Play Services for AR from.
            Log.w(TAG, "ARCore install check failed", e)
            fail(BridgeErrorCode.UNSUPPORTED, getString(R.string.scan_arcore_not_installed))
            return false
        }
        try {
            val newSession = Session(this)
            configure(newSession)
            session = newSession
        } catch (e: UnavailableUserDeclinedInstallationException) {
            fail(BridgeErrorCode.UNSUPPORTED, "ARCore installation was declined")
            return false
        } catch (e: UnavailableDeviceNotCompatibleException) {
            fail(BridgeErrorCode.UNSUPPORTED, getString(R.string.scan_arcore_unavailable))
            return false
        } catch (e: UnavailableException) {
            fail(BridgeErrorCode.UNSUPPORTED, "ARCore is unavailable: ${e.javaClass.simpleName}")
            return false
        } catch (e: SecurityException) {
            fail(BridgeErrorCode.PERMISSION_DENIED, getString(R.string.scan_camera_denied))
            return false
        } catch (e: Exception) {
            Log.e(TAG, "Could not start ARCore", e)
            fail(BridgeErrorCode.INTERNAL, "Could not start ARCore")
            return false
        }

        val currentSession = session ?: return false
        createdAtMs = System.currentTimeMillis()
        val depthKind = when {
            !scan.options.depth -> null
            currentSession.config.depthMode == Config.DepthMode.DISABLED -> null
            currentSession.isDepthModeSupported(Config.DepthMode.RAW_DEPTH_ONLY) -> ScanRecorder.DEPTH_RAW
            else -> ScanRecorder.DEPTH_SMOOTHED
        }
        val dir = try {
            store.create(scan.sessionId, scan.projectId, createdAtMs)
        } catch (e: Exception) {
            fail(BridgeErrorCode.INTERNAL, "Could not create scan storage")
            return false
        }
        val scanRecorder = ScanRecorder(dir, scan.options, depthKind)
        scanRecorder.lightMode = lightMode
        recorder = scanRecorder
        val sensors = SensorRecorder(
            this,
            sensors = scan.options.sensors,
            location = scan.options.location && !locationDeclined,
        )
        // The permission may have been refused while the scan screen was asking for it.
        if (scan.options.location && !locationDeclined && !sensors.hasLocationPermission()) {
            locationDenied = true
            sensors.setLocationEnabled(false)
        }
        sensorRecorder = sensors
        setToggles(sensors)
        capabilitiesProbedAtMs = System.currentTimeMillis()
        capabilities = runCatching { CapabilityProbe(this).probe(session = currentSession) }.getOrNull()
        return true
    }

    /** One native confirmation per scan whenever the page asks for location, before any permission prompt. */
    private fun confirmLocation() {
        if (locationDialogShown) return
        locationDialogShown = true
        android.app.AlertDialog.Builder(this)
            .setTitle(R.string.scan_location_confirm_title)
            .setMessage(R.string.scan_location_confirm_message)
            .setCancelable(false)
            .setPositiveButton(R.string.scan_location_allow) { _, _ ->
                locationConfirmed = true
                tryStart()
            }
            .setNegativeButton(R.string.scan_location_decline) { _, _ ->
                locationDeclined = true
                tryStart()
            }
            .show()
    }

    private fun configure(session: Session) {
        val configs = session.getSupportedCameraConfigs(
            CameraConfigFilter(session).setFacingDirection(CameraConfig.FacingDirection.BACK),
        )
        val choice = CameraConfigChoice.pick(
            configs.map { CameraConfigChoice.Candidate(it.imageSize.width, it.imageSize.height, it.fpsRange.upper) },
        )
        if (choice >= 0) session.cameraConfig = configs[choice]
        val chosen = session.cameraConfig
        sensorOrientationDeg = runCatching {
            getSystemService(CameraManager::class.java)
                ?.getCameraCharacteristics(chosen.cameraId)
                ?.get(CameraCharacteristics.SENSOR_ORIENTATION)
        }.getOrNull()
        cameraConfigJson = buildJsonObject {
            put("imageWidth", chosen.imageSize.width)
            put("imageHeight", chosen.imageSize.height)
            put("textureWidth", chosen.textureSize.width)
            put("textureHeight", chosen.textureSize.height)
            put("fpsMin", chosen.fpsRange.lower)
            put("fpsMax", chosen.fpsRange.upper)
            put("cameraId", chosen.cameraId)
        }

        val config = Config(session).apply {
            focusMode = Config.FocusMode.AUTO
            planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
            lightEstimationMode = if (scan.options.sensors) Config.LightEstimationMode.ENVIRONMENTAL_HDR else Config.LightEstimationMode.DISABLED
            instantPlacementMode = Config.InstantPlacementMode.DISABLED
            depthMode = when {
                !scan.options.depth -> Config.DepthMode.DISABLED
                session.isDepthModeSupported(Config.DepthMode.AUTOMATIC) -> Config.DepthMode.AUTOMATIC
                session.isDepthModeSupported(Config.DepthMode.RAW_DEPTH_ONLY) -> Config.DepthMode.RAW_DEPTH_ONLY
                else -> Config.DepthMode.DISABLED
            }
        }
        try {
            session.configure(config)
        } catch (e: UnsupportedConfigurationException) {
            if (config.lightEstimationMode == Config.LightEstimationMode.DISABLED) throw e
            config.lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
            session.configure(config)
        }
        lightMode = config.lightEstimationMode
    }

    private fun setToggles(sensors: SensorRecorder) {
        runOnUiThread {
            updatingToggles = true
            sensorsToggle.isChecked = sensors.sensorsEnabled
            locationToggle.isChecked = sensors.locationEnabled
            updatingToggles = false
        }
    }

    // --- GL thread ---

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        background.create()
        overlay.create()
        lines.create()
        textureBound = false
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        viewportWidth = width
        viewportHeight = height
        displayGeometryDirty = true
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val session = session ?: return
        val recorder = recorder ?: return
        if (!textureBound) {
            session.setCameraTextureName(background.textureId)
            textureBound = true
        }
        if (displayGeometryDirty && viewportWidth > 0) {
            session.setDisplayGeometry(displayRotation(), viewportWidth, viewportHeight)
            displayGeometryDirty = false
        }
        pendingLightMode?.let { mode ->
            pendingLightMode = null
            runCatching { session.configure(session.config.apply { lightEstimationMode = mode }) }
                .onFailure { Log.w(TAG, "Could not change light estimation", it) }
        }
        val frame = try {
            session.update()
        } catch (e: SessionPausedException) {
            return
        } catch (e: CameraNotAvailableException) {
            runOnUiThread { fail(BridgeErrorCode.INTERNAL, "The camera became unavailable") }
            return
        } catch (e: Exception) {
            Log.w(TAG, "Frame update failed", e)
            return
        }
        background.draw(frame)
        val camera = frame.camera
        if (phase == Phase.SCANNING) {
            try {
                recorder.onFrame(session, frame, camera)
                if (camera.trackingState == TrackingState.TRACKING) {
                    camera.pose.toMatrix(headingPose, 0)
                    sensorRecorder?.onFrame(frame.timestamp, headingPose)
                }
                pendingTap.getAndSet(null)?.let { tap -> handleMarkTap(session, frame, camera, recorder, tap[0], tap[1]) }
                if (confirmRequested.getAndSet(false)) confirmCandidate(session, frame, recorder)
            } catch (e: Exception) {
                Log.w(TAG, "Frame processing failed", e)
            }
        }
        if (camera.trackingState == TrackingState.TRACKING) {
            camera.getViewMatrix(view, 0)
            camera.getProjectionMatrix(projection, 0, 0.1f, 100f)
            overlay.draw(recorder.overlayPoints, recorder.overlayCount, view, projection)
            lines.draw(marks.snapshot(), marks.pending(), candidate, view, projection)
        }
        if (progressGate.ready(frame.timestamp)) {
            reportProgress(recorder, camera.trackingState, camera.trackingFailureReason)
        }
    }

    private fun reportProgress(recorder: ScanRecorder, state: TrackingState, failure: TrackingFailureReason) {
        val elapsedMs = if (startedAtElapsed == 0L) 0L else SystemClock.elapsedRealtime() - startedAtElapsed
        val keyframes = recorder.selector.count
        val planes = recorder.planeCount
        val points = recorder.voxels.size
        val losses = recorder.trajectory.trackingLossCount
        ScanCoordinator.progress(
            buildJsonObject {
                put("sessionId", scan.sessionId)
                put("trackingState", state.name.lowercase())
                put("trackingFailure", failure.takeIf { it != TrackingFailureReason.NONE }?.name?.lowercase())
                put("keyframes", keyframes)
                put("maxKeyframes", recorder.selector.maxKeyframes)
                put("planes", planes)
                put("points", points)
                put("trackingLossCount", losses)
                put("elapsedMs", elapsedMs)
            },
        )
        runOnUiThread {
            if (phase != Phase.SCANNING) return@runOnUiThread
            statusText.text = trackingLabel(state, failure)
            val seconds = elapsedMs / 1000
            statsText.text = getString(
                R.string.scan_stats,
                keyframes, recorder.selector.maxKeyframes, planes, points, seconds / 60, seconds % 60,
            )
            if (recorder.selector.limitReached) hintText.setText(R.string.scan_keyframe_limit)
            sensorRecorder?.let { updateSensorsText(it) }
        }
    }

    private fun updateSensorsText(sensors: SensorRecorder) {
        if (!sensors.sensorsEnabled) {
            sensorsText.setText(R.string.scan_sensors_off)
            return
        }
        val live = sensors.live
        val heading = if (live == null) {
            getString(if (sensors.hasRotationVector) R.string.scan_heading_wait else R.string.scan_heading_unavailable)
        } else {
            val true_ = live.azimuthTrueDeg
            getString(
                R.string.scan_heading,
                Math.round(true_ ?: live.azimuthMagneticDeg).toInt() % 360,
                getString(if (true_ != null) R.string.scan_heading_true else R.string.scan_heading_magnetic),
                getString(compassLabel(live.magnetometerAccuracy)),
                live.headingAccuracyDeg?.let { getString(R.string.scan_heading_accuracy, Math.round(it).toInt()) } ?: "",
            )
        }
        val location = if (sensors.locationEnabled) {
            "\n" + if (sensors.fixCount == 0) getString(R.string.scan_location_waiting) else getString(R.string.scan_location_fixes, sensors.fixCount)
        } else {
            ""
        }
        sensorsText.text = heading + location
    }

    private fun compassLabel(accuracy: Int): Int = when (accuracy) {
        3 -> R.string.compass_high
        2 -> R.string.compass_medium
        1 -> R.string.compass_low
        else -> R.string.compass_unreliable
    }

    private fun trackingLabel(state: TrackingState, failure: TrackingFailureReason): String = getString(
        when (state) {
            TrackingState.TRACKING -> R.string.tracking_ok
            TrackingState.PAUSED -> when (failure) {
                TrackingFailureReason.INSUFFICIENT_LIGHT -> R.string.tracking_dark
                TrackingFailureReason.EXCESSIVE_MOTION -> R.string.tracking_fast
                TrackingFailureReason.INSUFFICIENT_FEATURES -> R.string.tracking_features
                TrackingFailureReason.CAMERA_UNAVAILABLE -> R.string.tracking_camera
                else -> R.string.tracking_searching
            }
            TrackingState.STOPPED -> R.string.tracking_stopped
        },
    )


    // --- Assisted boundary marking ---

    // The surface only forwards the lifted finger as a tap for marking; it has no click action of its own.
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun setUpMarking() {
        val labels = resources.getStringArray(R.array.mark_kinds)
        markKind.adapter = object : ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, labels) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply { setTextColor(getColor(R.color.brand_foreground)) }
        }.also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        markKind.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val kind = BoundaryKind.entries[position]
                markKindSelected = kind
                // "To ceiling" is on for walls, off for glass, and unavailable for mirrors, doors and openings.
                markCeiling.isEnabled = kind.offersCeiling
                markCeiling.isChecked = kind.ceilingByDefault
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        markHeight.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                heightText = s?.toString().orEmpty()
            }
        })
        markCeiling.setOnCheckedChangeListener { _, checked -> toCeiling = checked && markKindSelected.offersCeiling }
        markToggle.setOnClickListener { setMarking(!marking) }
        markConfirm.setOnClickListener {
            if (candidate != null) confirmRequested.set(true)
        }
        markUndo.setOnClickListener {
            pendingTap.set(null)
            confirmRequested.set(false)
            candidate = null
            // A typed height belongs to the mark being finished; dropping its start drops the height too.
            if (marks.pending() != null) markHeight.text = null
            if (!marks.undo()) Toast.makeText(this, R.string.mark_nothing_to_undo, Toast.LENGTH_SHORT).show()
            updateMarkUi()
        }
        surface.setOnTouchListener { v, event ->
            val action = when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> MarkTouch.Action.DOWN
                MotionEvent.ACTION_UP -> MarkTouch.Action.UP
                else -> MarkTouch.Action.OTHER
            }
            val scanning = phase == Phase.SCANNING
            // The surface is not clickable, so it must take ACTION_DOWN to be offered the ACTION_UP of the same gesture.
            if (MarkTouch.enqueuesTap(marking, scanning, action)) {
                // Resolved on the GL thread against the next frame, so the hit-test matches what is on screen.
                pendingTap.set(floatArrayOf(event.x, event.y))
                v.performClick()
            }
            MarkTouch.consumes(marking, scanning, action)
        }
    }

    private fun setMarking(on: Boolean) {
        if (on && phase != Phase.SCANNING) return
        marking = on
        pendingTap.set(null)
        confirmRequested.set(false)
        candidate = null
        markPanel.visibility = if (on) View.VISIBLE else View.GONE
        markToggle.setText(if (on) R.string.mark_stop else R.string.mark_start)
        updateMarkUi()
    }

    /** Shows [message], or the next step and the mark count; [detail] goes on a second line. */
    private fun updateMarkUi(message: Int? = null, detail: String? = null) {
        runOnUiThread {
            val pending = marks.pending()
            markKind.isEnabled = pending == null
            markConfirm.isEnabled = candidate != null
            val line = message?.let(::getString)
                ?: getString(
                    R.string.mark_step_count,
                    getString(if (pending == null) R.string.mark_tap_start else R.string.mark_tap_end),
                    marks.count(),
                )
            markStatus.text = if (detail == null) line else getString(R.string.mark_two_lines, line, detail)
        }
    }

    private fun planeKind(plane: Plane): HitKind = when (plane.type) {
        Plane.Type.HORIZONTAL_UPWARD_FACING -> HitKind.HORIZONTAL_UP_PLANE
        Plane.Type.HORIZONTAL_DOWNWARD_FACING -> HitKind.HORIZONTAL_DOWN_PLANE
        else -> HitKind.VERTICAL_PLANE
    }

    private fun trackedPlanes(session: Session): List<Pair<Plane, PlaneSummary>> =
        session.getAllTrackables(Plane::class.java)
            .filter { it.trackingState == TrackingState.TRACKING && it.subsumedBy == null }
            .mapIndexed { index, plane ->
                // Provisional ids: a plane only gets its stream id (and so a place in the plane-set) once a mark uses it.
                plane to PlaneSummary("p$index", planeKind(plane), true, plane.centerPose.ty(), plane.extentX, plane.extentZ)
            }

    /** GL thread: turns a tap into a candidate floor point, or refuses it with a reason. Nothing is committed yet. */
    private fun handleMarkTap(session: Session, frame: Frame, camera: com.google.ar.core.Camera, recorder: ScanRecorder, x: Float, y: Float) {
        if (!marking) return
        candidate = null
        if (camera.trackingState != TrackingState.TRACKING) {
            updateMarkUi(R.string.mark_not_tracking)
            return
        }
        val planes = trackedPlanes(session).map { it.second }
        val cameraY = camera.pose.ty()
        val hits = frame.hitTest(x, y)
        val candidates = hits.map { hit ->
            val trackable = hit.trackable
            val plane = trackable as? Plane
            val kind = when {
                plane != null -> planeKind(plane)
                trackable is DepthPoint -> HitKind.DEPTH_POINT
                trackable is Point -> HitKind.FEATURE_POINT
                trackable is InstantPlacementPoint -> HitKind.INSTANT_PLACEMENT
                else -> HitKind.OTHER
            }
            HitCandidate(
                kind = kind,
                inPolygon = plane?.isPoseInPolygon(hit.hitPose) == true,
                tracking = trackable.trackingState == TrackingState.TRACKING,
                distanceM = hit.distance,
                pose = FloatArray(16).also { hit.hitPose.toMatrix(it, 0) },
                planeId = null,
                cameraY = cameraY,
            )
        }
        val decision = BoundaryMarking.chooseFloorHit(candidates, BoundaryMarking.floorY(planes))
        if (decision is HitDecision.Refused) {
            updateMarkUi(
                when (decision.reason) {
                    Refusal.NO_HIT -> R.string.mark_no_hit
                    Refusal.NOT_TRACKING -> R.string.mark_not_tracking
                    Refusal.NOT_FLOOR -> R.string.mark_not_floor
                    Refusal.OBSTRUCTED -> R.string.mark_obstructed
                    Refusal.ABOVE_FLOOR -> R.string.mark_above_floor
                    Refusal.OUT_OF_RANGE -> R.string.mark_out_of_range
                    Refusal.TOO_SHALLOW -> R.string.mark_too_shallow
                },
            )
            return
        }
        val accepted = (decision as HitDecision.Accepted).hit
        val plane = hits.getOrNull(candidates.indexOf(accepted))?.trackable as? Plane
        candidate = BasePoint(accepted.pose, plane?.let(recorder::planeIdFor), frame.timestamp)
        updateMarkUi(R.string.mark_confirm_prompt)
    }

    /** GL thread: commits the candidate point as a mark start or end. */
    private fun confirmCandidate(session: Session, frame: Frame, recorder: ScanRecorder) {
        val point = candidate ?: return
        val tracked = trackedPlanes(session)
        val planes = tracked.map { it.second }
        // The typed height is read only when a mark is being finished.
        val finishing = marks.pending() != null
        val typed = if (finishing) BoundaryMarking.parseTypedHeight(heightText) else null
        if (finishing && heightText.isNotBlank() && typed == null) {
            updateMarkUi(R.string.mark_bad_height)
            return
        }
        val result = marks.tap(markKindSelected, point, System.currentTimeMillis()) { kind, baseY ->
            val choice = BoundaryMarking.resolveHeight(kind, typed, toCeiling, baseY, planes)
            // Swap the provisional plane id for the stream id only now that the plane is used.
            val ceilingPlane = tracked.firstOrNull { it.second.id == choice.ceilingPlaneId }?.first
            if (ceilingPlane == null) choice else BoundaryMarking.HeightChoice(choice.metres, choice.source, recorder.planeIdFor(ceilingPlane))
        }
        if (result is BoundaryMarkBook.Result.Started || result is BoundaryMarkBook.Result.Completed) candidate = null
        when (result) {
            is BoundaryMarkBook.Result.Started -> updateMarkUi()
            is BoundaryMarkBook.Result.Completed -> {
                val height = result.mark.height
                runOnUiThread { markHeight.text = null }
                updateMarkUi(
                    detail = when (height.source) {
                        HeightSource.CEILING_PLANE -> getString(R.string.mark_height_ceiling, height.metres)
                        HeightSource.TYPED -> getString(R.string.mark_height_typed, height.metres)
                        HeightSource.UNKNOWN -> getString(R.string.mark_height_unknown)
                    },
                )
            }
            BoundaryMarkBook.Result.TooShort -> updateMarkUi(R.string.mark_too_short)
            BoundaryMarkBook.Result.TooLong -> updateMarkUi(R.string.mark_too_long)
            BoundaryMarkBook.Result.TooSteep -> updateMarkUi(R.string.mark_too_steep)
            BoundaryMarkBook.Result.Full -> updateMarkUi(R.string.mark_full)
        }
    }

    // --- Finish, cancel, fail ---

    private fun finishScan() {
        if (phase != Phase.SCANNING) return
        phase = Phase.FINALIZING
        finishButton.isEnabled = false
        cancelButton.isEnabled = false
        statusText.setText(R.string.scan_saving)
        ScanCoordinator.state(scan.sessionId, "finalizing")
        sensorsToggle.isEnabled = false
        locationToggle.isEnabled = false
        markToggle.isEnabled = false
        marking = false
        pendingTap.set(null)
        candidate = null
        markPanel.visibility = View.GONE
        sensorRecorder?.stop()
        val planes = recorder?.latestPlanes.orEmpty()
        // A start point without an end is not a mark; say so in the bundle rather than dropping it silently.
        if (marks.pending() != null) recorder?.warnings?.add("boundary-mark-incomplete")
        val boundaryMarks = marks.snapshot()
        finalizer.execute { finalizeBundle(planes, boundaryMarks) }
    }

    private fun finalizeBundle(planes: List<PlaneRecord>, boundaryMarks: List<BoundaryMark>) {
        val recorder = recorder ?: return
        try {
            recorder.stop()
            if (!recorder.drain()) recorder.warnings.add("keyframe-encoding-timeout")
            val captured = recorder.captured()
            val keyframes = captured.keyframes
            if (planes.isEmpty()) recorder.warnings.add("no-planes-detected")
            if (keyframes.isEmpty()) recorder.warnings.add("no-keyframes")
            val sensors = sensorRecorder
            val rawCapture = sensors?.takeIf { it.sensorsEnabled || it.locationEnabled }?.captured()
            // Declination is applied here from the retained fixes, never while recording: no fixes, no declination.
            val declination = rawCapture?.let { Declination.fromFixes(it.fixes, AndroidDeclination) }
            val sensorCapture = rawCapture?.let {
                SensorCapture(it.orientation, Declination.apply(it.heading, declination), it.fixes, it.pressure, it.timestampSource, it.warnings, it.diagnostics)
            }
            if (sensors != null) {
                if (sensors.sensorsEnabled && !sensors.hasRotationVector) recorder.warnings.add("rotation-vector-unavailable")
                if (sensors.sensorsEnabled && NorthEstimator.estimate(sensorCapture?.heading.orEmpty()) == null) {
                    recorder.warnings.add("true-north-unavailable")
                    // The bundle explains itself: why the estimator had nothing, and how heading frames fared.
                    val reason = NorthEstimator.unavailableReason(sensorCapture?.heading.orEmpty())
                    recorder.warnings.add("true-north-diagnostics: $reason; ${sensorCapture?.diagnostics.orEmpty()}")
                }
                if (sensors.sensorsEnabled && NorthEstimator.estimate(sensorCapture?.heading.orEmpty())?.segmentsAgree == false) {
                    recorder.warnings.add("true-north-segments-disagree")
                }
                if (locationDeclined) recorder.warnings.add("location-declined")
                if (!locationDeclined && (scan.options.location || sensors.locationEnabled)) {
                    if (!sensors.locationEnabled && locationDenied) recorder.warnings.add("location-permission-denied")
                    else if (sensors.locationEnabled && sensorCapture?.fixes.isNullOrEmpty()) recorder.warnings.add("location-unavailable")
                }
            }
            val input = BundleInput(
                sessionId = scan.sessionId,
                projectId = scan.projectId,
                createdAtMs = createdAtMs,
                appVersion = BuildConfig.VERSION_NAME,
                device = DeviceInfo(Build.MANUFACTURER, Build.MODEL, "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})"),
                nativeCapabilities = capabilities ?: JsonObject(emptyMap()),
                capabilitiesProbedAtMs = capabilitiesProbedAtMs,
                trajectory = captured.trajectory,
                keyframes = keyframes,
                depth = captured.depth,
                planes = planes,
                points = captured.points,
                voxelSizeM = captured.voxelSizeM,
                minConfidence = captured.minConfidence,
                trackingLossCount = captured.trackingLossCount,
                warnings = recorder.warnings.toList(),
                startTimestampNs = recorder.startTimestampNs,
                sensorOrientationDeg = sensorOrientationDeg,
                arcore = buildJsonObject {
                    put("cameraConfig", cameraConfigJson)
                    put("depthKind", recorder.depthKind)
                    put("keyframeSpacingM", scan.options.keyframeSpacingM)
                    put("keyframeAngleDeg", scan.options.keyframeAngleDeg)
                    put("maxKeyframes", scan.options.maxKeyframes)
                },
                // A group the user switched off is empty, so only what was recorded is written.
                sensors = sensorCapture,
                lightEstimates = captured.lightEstimates,
                pointMaxDistanceM = ScanRecorder.POINT_MAX_DISTANCE_M.toDouble(),
                boundaryMarks = boundaryMarks,
            )
            val bundle = ScanBundleWriter(store.dir(scan.sessionId)).finalize(input)
            val record = store.read(scan.sessionId)
                ?: SessionRecord(scan.sessionId, createdAtMs, scan.projectId, SessionRecord.RECORDING)
            store.write(
                record.copy(
                    state = SessionRecord.READY,
                    keyframes = keyframes.size,
                    bytes = bundle.totalBytes,
                    manifestSha256 = bundle.manifest.sha256,
                ),
            )
            runOnUiThread {
                phase = Phase.DONE
                ScanCoordinator.state(scan.sessionId, "ready") {
                    put("keyframes", keyframes.size)
                    put("bytes", bundle.totalBytes)
                }
                ScanCoordinator.end(scan.sessionId)
                finish()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not save the scan", e)
            keepFailed("Could not save the scan: ${e.message ?: e.javaClass.simpleName}")
        } catch (e: OutOfMemoryError) {
            keepFailed("Could not save the scan: out of memory")
        }
    }

    /**
     * Saving failed after capture (disk full, an artifact over 16 MB, ...). The files stay,
     * marked `failed` with the reason, so the user can free space and discard or inspect them.
     * Runs on the finalizer thread.
     */
    private fun keepFailed(message: String) {
        val reason = message.take(300)
        runCatching {
            val record = store.read(scan.sessionId)
                ?: SessionRecord(scan.sessionId, createdAtMs, scan.projectId, SessionRecord.RECORDING)
            store.write(record.copy(state = SessionRecord.FAILED, error = reason))
        }
        runOnUiThread {
            phase = Phase.DONE
            Toast.makeText(this, getString(R.string.scan_failed, reason), Toast.LENGTH_LONG).show()
            ScanCoordinator.state(scan.sessionId, "failed") {
                put("error", NativeBridge.errorJson(BridgeErrorCode.INTERNAL, reason))
                put("kept", true)
            }
            ScanCoordinator.end(scan.sessionId)
            finish()
        }
    }

    private fun cancelScan() {
        if (phase == Phase.FINALIZING || phase == Phase.DONE) return
        discardPartial("cancelled", null)
        finish()
    }

    private fun fail(code: BridgeErrorCode, message: String) {
        if (phase == Phase.DONE) return
        Toast.makeText(this, getString(R.string.scan_failed, message), Toast.LENGTH_LONG).show()
        discardPartial("failed", NativeBridge.errorJson(code, message))
        finish()
    }

    private fun discardPartial(state: String, error: JsonObject?) {
        phase = Phase.DONE
        val sessionId = scan.sessionId
        val recorder = recorder
        finalizer.execute {
            runCatching { recorder?.abort() }
            runCatching { store.discard(sessionId) }
        }
        ScanCoordinator.state(sessionId, state) { error?.let { put("error", it) } }
        ScanCoordinator.end(sessionId)
    }

    @Suppress("DEPRECATION")
    private fun displayRotation(): Int =
        if (Build.VERSION.SDK_INT >= 30) display?.rotation ?: Surface.ROTATION_0 else windowManager.defaultDisplay.rotation

    companion object {
        private const val TAG = "ScanActivity"
        private const val EXTRA_SESSION_ID = "sessionId"
        private const val PROGRESS_INTERVAL_NS = 500_000_000L
        private const val PADDING_PX = 32

        fun intent(context: Context, sessionId: String): Intent =
            Intent(context, ScanActivity::class.java).putExtra(EXTRA_SESSION_ID, sessionId)

        /** App-private scan storage; never external storage. */
        fun scansRoot(context: Context) = java.io.File(context.filesDir, "scans")
    }
}
