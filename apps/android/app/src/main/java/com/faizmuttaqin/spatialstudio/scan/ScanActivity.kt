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
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.EditText
import android.widget.FrameLayout
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
import com.faizmuttaqin.spatialstudio.AppConfig
import com.faizmuttaqin.spatialstudio.live.LivePanel
import com.faizmuttaqin.spatialstudio.live.LiveStream
import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import com.faizmuttaqin.spatialstudio.bridge.NativeBridge
import com.faizmuttaqin.spatialstudio.capabilities.CapabilityProbe
import com.faizmuttaqin.spatialstudio.scan.gl.CameraBackground
import com.faizmuttaqin.spatialstudio.scan.gl.CoverageOverlay
import com.faizmuttaqin.spatialstudio.scan.gl.EdgeOverlay
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

    /**
     * STARTING: the camera is coming up. READY: camera and tracking run, nothing is recorded, and the torch, sensors
     * and location can change. SCANNING: recording; the ARCore configuration is fixed from here on.
     */
    private enum class Phase { STARTING, READY, SCANNING, FINALIZING, DONE }

    private lateinit var scan: ScanCoordinator.ActiveScan
    private lateinit var store: ScanStore
    private lateinit var surface: GLSurfaceView
    private lateinit var statusText: TextView
    private lateinit var statsText: TextView
    private lateinit var sensorsText: TextView
    private lateinit var guidanceText: TextView
    private lateinit var counterText: TextView
    private lateinit var floorChip: TextView
    private lateinit var infoCard: View
    private lateinit var crosshair: View
    private lateinit var backButton: ImageButton
    private lateinit var primaryButton: ImageButton
    private lateinit var toolsButton: ImageButton
    private lateinit var torchButton: ImageButton
    private lateinit var sensorsButton: ImageButton
    private lateinit var locationButton: ImageButton
    private lateinit var infoButton: ImageButton
    private lateinit var resumeCard: View
    private lateinit var resumeText: TextView
    private lateinit var resumeButton: Button
    private lateinit var markPanel: View
    private lateinit var markStatus: TextView
    private lateinit var markKind: Spinner
    private lateinit var markHeight: EditText
    private lateinit var markUndo: Button
    private lateinit var markCeiling: CheckBox
    private lateinit var liveContainer: FrameLayout
    private var livePanel: LivePanel? = null
    private val liveStream = LiveStream()

    // Assisted boundary marking (v1.2). Marks live here; the GL thread resolves taps against ARCore.
    private val marks = BoundaryMarkBook()
    @Volatile private var marking = false
    @Volatile private var markKindSelected = BoundaryKind.WALL
    @Volatile private var heightText = ""
    @Volatile private var toCeiling = true
    private val pendingTap = AtomicReference<FloatArray?>(null)

    /** A tapped floor point waiting for Confirm; shown in the camera view. */
    @Volatile private var candidate: BasePoint? = null

    @Volatile private var phase = Phase.STARTING
    private var session: Session? = null
    private var recorder: ScanRecorder? = null
    private var capabilities: JsonObject? = null
    private var capabilitiesProbedAtMs = 0L
    private var cameraConfigJson: JsonObject = JsonObject(emptyMap())
    private var sensorOrientationDeg: Int? = null
    private var locationDeclined = false
    private var locationDialogShown = false
    private var locationConfirmed = false
    private var sensorRecorder: SensorRecorder? = null
    private var lightMode = Config.LightEstimationMode.DISABLED
    private var locationRequested = false
    private var locationDenied = false
    private val explained = HashSet<Int>()
    @Volatile private var trackingNow = false
    private var everTracked = false
    private val torchRequest = AtomicReference<Boolean?>(null)
    private val lightRequest = AtomicReference<Boolean?>(null)

    // Torch experiment (v1.3): decided at session configure from options.torch; never changed mid-scan, because
    // a reconfigure disturbs tracking and shifts the frame clock (device finding of 2026-11-25).
    private var torchProbe: Boolean? = null
    private var torchOn = false
    private var torchConfigureFailed = false
    private var torchLightDegraded = false
    private val headingPose = FloatArray(16)
    private var installRequested = false
    private var permissionRequested = false
    private var createdAtMs = 0L
    private var startedAtElapsed = 0L

    private val background = CameraBackground()
    private val overlay = PointOverlay()
    private val lines = LineOverlay()
    private val coverageOverlay = CoverageOverlay()
    private val edgeOverlay = EdgeOverlay()
    private val edgePose = FloatArray(16)
    @Volatile private var showModel = true
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
        } else {
            locationDenied = false
            locationDeclined = false
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
        sensorsText = ActivityCompat.requireViewById(this, R.id.scan_sensors)
        guidanceText = ActivityCompat.requireViewById(this, R.id.scan_guidance)
        counterText = ActivityCompat.requireViewById(this, R.id.scan_counter)
        floorChip = ActivityCompat.requireViewById(this, R.id.scan_floor_chip)
        infoCard = ActivityCompat.requireViewById(this, R.id.scan_info_card)
        crosshair = ActivityCompat.requireViewById(this, R.id.scan_crosshair)
        backButton = ActivityCompat.requireViewById(this, R.id.scan_back)
        primaryButton = ActivityCompat.requireViewById(this, R.id.scan_primary)
        toolsButton = ActivityCompat.requireViewById(this, R.id.scan_tools)
        torchButton = ActivityCompat.requireViewById(this, R.id.scan_btn_torch)
        sensorsButton = ActivityCompat.requireViewById(this, R.id.scan_btn_sensors)
        locationButton = ActivityCompat.requireViewById(this, R.id.scan_btn_location)
        infoButton = ActivityCompat.requireViewById(this, R.id.scan_btn_info)
        resumeCard = ActivityCompat.requireViewById(this, R.id.scan_resume_card)
        resumeText = ActivityCompat.requireViewById(this, R.id.scan_resume_text)
        resumeButton = ActivityCompat.requireViewById(this, R.id.scan_resume)
        resumeButton.setOnClickListener {
            recorder?.requestResume()
            resumeCard.visibility = View.GONE
        }
        markPanel = ActivityCompat.requireViewById(this, R.id.scan_mark_panel)
        markStatus = ActivityCompat.requireViewById(this, R.id.scan_mark_status)
        markKind = ActivityCompat.requireViewById(this, R.id.scan_mark_kind)
        markHeight = ActivityCompat.requireViewById(this, R.id.scan_mark_height)
        markUndo = ActivityCompat.requireViewById(this, R.id.scan_mark_undo)
        markCeiling = ActivityCompat.requireViewById(this, R.id.scan_mark_ceiling)
        setUpMarking()
        liveContainer = ActivityCompat.requireViewById(this, R.id.scan_live)
        setUpLivePreview()
        setUpControls()

        val top = ActivityCompat.requireViewById<View>(this, R.id.scan_top)
        val bottom = ActivityCompat.requireViewById<View>(this, R.id.scan_bottom)
        ViewCompat.setOnApplyWindowInsetsListener(ActivityCompat.requireViewById(this, R.id.scan_root)) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val inset = (INSET_PADDING_DP * resources.displayMetrics.density).toInt()
            top.setPadding(top.paddingLeft, bars.top + inset, top.paddingRight, top.paddingBottom)
            bottom.setPadding(bottom.paddingLeft, bottom.paddingTop, bottom.paddingRight, bars.bottom + inset)
            insets
        }

        surface.preserveEGLContextOnPause = true
        surface.setEGLContextClientVersion(2)
        surface.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        surface.setRenderer(this)
        surface.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        surface.setWillNotDraw(false)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = confirmCancel()
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
        // The camera and tracking run in the ready state; nothing is recorded until the user taps Record.
        if (phase == Phase.STARTING) {
            phase = Phase.READY
            updateControls()
        }
        sensorRecorder?.start()
        livePanel?.onResume()
        if (phase == Phase.SCANNING) ScanCoordinator.state(scan.sessionId, "scanning")
    }

    override fun onPause() {
        super.onPause()
        if (!::scan.isInitialized) return
        // Stop rendering first, then release the camera. No capture continues in the background.
        surface.onPause()
        // The preview port or socket never outlives the screen being in front.
        livePanel?.onPause()
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
        livePanel?.destroy()
        livePanel = null
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
        scanRecorder.live = liveStream
        scanRecorder.setTorchState(torchOn, torchProbe, torchConfigureFailed, torchLightDegraded)
        if (scan.options.torch && !torchOn) {
            runOnUiThread { Toast.makeText(this, R.string.scan_torch_unsupported, Toast.LENGTH_LONG).show() }
        }
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
        // Settle the light estimation mode first (HDR may be unsupported), so the torch probe below runs against
        // the configuration that will actually be used.
        try {
            session.configure(config)
        } catch (e: UnsupportedConfigurationException) {
            if (config.lightEstimationMode == Config.LightEstimationMode.DISABLED) throw e
            config.lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
            session.configure(config)
        }
        if (scan.options.torch) {
            torchOn = applyTorch(session, config)
        }
        lightMode = config.lightEstimationMode
    }

    /**
     * Probes and applies the torch against the settled configuration. When the probe fails with the current
     * light estimation mode, it is retried with ambient intensity (the mode is restored if that fails too).
     * Never called after the scan starts: a mid-scan reconfigure disturbs tracking and the frame clock.
     */
    @Suppress("DEPRECATION") // isSupported is the probe the reference uses; the replacement is not in ARCore 1.57.
    private fun applyTorch(session: Session, config: Config): Boolean {
        torchConfigureFailed = false
        torchLightDegraded = false
        val originalLight = config.lightEstimationMode
        config.flashMode = Config.FlashMode.TORCH
        var supported = session.isSupported(config)
        var degradedLight = false
        if (!supported && originalLight != Config.LightEstimationMode.AMBIENT_INTENSITY && originalLight != Config.LightEstimationMode.DISABLED) {
            config.lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
            supported = session.isSupported(config)
            degradedLight = supported
            if (!supported) config.lightEstimationMode = originalLight
        }
        torchProbe = supported
        if (supported) {
            try {
                session.configure(config)
                if (degradedLight) torchLightDegraded = true
                return true
            } catch (e: UnsupportedConfigurationException) {
                torchConfigureFailed = true
            }
        }
        config.flashMode = Config.FlashMode.OFF
        config.lightEstimationMode = originalLight
        session.configure(config)
        return false
    }

    /**
     * GL thread, ready state only. Changes the torch with the camera running and nothing recorded; tracking may
     * take a moment to settle, which is why recording waits for the user's tap. Never reached once recording starts.
     */
    private fun applyTorchWhileReady(session: Session, recorder: ScanRecorder, want: Boolean) {
        val config = session.config
        var on = false
        try {
            if (want) {
                on = applyTorch(session, config)
            } else {
                config.flashMode = Config.FlashMode.OFF
                if (torchLightDegraded) {
                    // The torch had cost the light estimation its HDR mode; with the torch off, try to give it back.
                    config.lightEstimationMode = Config.LightEstimationMode.ENVIRONMENTAL_HDR
                    try {
                        session.configure(config)
                    } catch (e: UnsupportedConfigurationException) {
                        config.lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
                        session.configure(config)
                    }
                    torchLightDegraded = false
                } else {
                    session.configure(config)
                }
                torchConfigureFailed = false
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not change the torch", e)
            on = false
        }
        torchOn = on
        recorder.setTorchState(on, torchProbe, torchConfigureFailed, torchLightDegraded)
        afterReadyReconfigure(session, recorder)
        runOnUiThread {
            updateControls()
            if (want && !on) Toast.makeText(this, R.string.scan_torch_unsupported, Toast.LENGTH_LONG).show()
        }
    }

    /**
     * GL thread, ready state only. Sensors on or off also switches ARCore's light estimation, which needs a
     * reconfigure that is only allowed before recording.
     */
    private fun applyLightWhileReady(session: Session, recorder: ScanRecorder, on: Boolean) {
        val config = session.config
        try {
            config.lightEstimationMode = if (on) Config.LightEstimationMode.ENVIRONMENTAL_HDR else Config.LightEstimationMode.DISABLED
            try {
                session.configure(config)
            } catch (e: UnsupportedConfigurationException) {
                if (!on) throw e
                config.lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
                session.configure(config)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not change light estimation", e)
        }
        lightMode = session.config.lightEstimationMode
        // A light mode set for the sensors being on is not "degraded for the torch".
        if (on) torchLightDegraded = false
        recorder.setLightEnabled(on, lightMode)
        recorder.setTorchState(torchOn, torchProbe, torchConfigureFailed, torchLightDegraded)
        afterReadyReconfigure(session, recorder)
    }

    /** A reconfigure can move the frame clock's base: the estimate starts again and Record waits for it. */
    @Suppress("UNUSED_PARAMETER")
    private fun afterReadyReconfigure(session: Session, recorder: ScanRecorder) {
        sensorRecorder?.resetFrameClock()
        runOnUiThread { updateControls() }
    }

    private fun setToggles(sensors: SensorRecorder) {
        runOnUiThread { updateControls(sensors) }
    }

    /** Shows each toggle's state, the primary button's job, and what may still change. UI thread. */
    private fun updateControls(sensors: SensorRecorder? = sensorRecorder) {
        val ready = phase == Phase.READY
        val scanning = phase == Phase.SCANNING
        val busy = phase == Phase.FINALIZING || phase == Phase.DONE
        setToggleState(torchButton, torchOn)
        // Locked once recording starts: still tappable, to read why.
        torchButton.alpha = if (scanning) 0.5f else 1f
        sensors?.let {
            setToggleState(sensorsButton, it.sensorsEnabled)
            setToggleState(locationButton, it.locationEnabled)
        }
        infoButton.isSelected = infoCard.visibility == View.VISIBLE
        primaryButton.setImageResource(if (scanning) R.drawable.ic_check_dark else R.drawable.ic_record)
        primaryButton.contentDescription = getString(if (scanning) R.string.scan_finish_description else R.string.scan_record_description)
        primaryButton.isEnabled = !busy && phase != Phase.STARTING
        primaryButton.alpha = if (ready && !canRecord()) 0.5f else 1f
        toolsButton.isEnabled = !busy
        counterText.visibility = if (scanning) View.VISIBLE else View.INVISIBLE
    }

    private fun setToggleState(button: ImageButton, on: Boolean) {
        button.isSelected = on
        ViewCompat.setStateDescription(button, getString(if (on) R.string.state_on else R.string.state_off))
    }

    /** Wires the top bar, the round button and the tools menu. */
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun setUpControls() {
        backButton.setOnClickListener { confirmCancel() }
        primaryButton.setOnClickListener {
            when (phase) {
                Phase.READY -> startRecording()
                Phase.SCANNING -> finishScan()
                else -> Unit
            }
        }
        explainable(torchButton, R.string.explain_torch) {
            if (phase != Phase.READY) {
                Toast.makeText(this, R.string.torch_locked, Toast.LENGTH_SHORT).show()
            } else {
                torchRequest.set(!torchOn)
            }
        }
        explainable(sensorsButton, R.string.explain_sensors) {
            val sensors = sensorRecorder ?: return@explainable
            val on = !sensors.sensorsEnabled
            sensors.setSensorsEnabled(on)
            if (phase == Phase.READY) {
                // Light estimation follows the sensors: a reconfigure, which is only allowed before recording.
                lightRequest.set(on)
            } else {
                // Recording only: the ARCore configuration stays fixed (a reconfigure disturbs tracking).
                recorder?.setLightEnabled(on, lightMode)
            }
            if (!on) sensorsText.setText(R.string.scan_sensors_off)
            updateControls(sensors)
        }
        explainable(locationButton, R.string.explain_location) {
            val sensors = sensorRecorder ?: return@explainable
            val on = !sensors.locationEnabled
            if (on && !sensors.hasLocationPermission()) {
                locationPermission.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
            } else {
                if (on) locationDeclined = false
                sensors.setLocationEnabled(on)
                updateControls(sensors)
            }
        }
        explainable(infoButton, R.string.explain_info) {
            infoCard.visibility = if (infoCard.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            updateControls()
        }
        toolsButton.setOnClickListener { showTools() }
        floorChip.setOnClickListener {
            if (livePanel != null) {
                liveContainer.visibility = if (liveContainer.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            }
        }
    }

    /** A click that does [action] and, the first time, says what the control is for; a long press always does. */
    private fun explainable(button: ImageButton, explanation: Int, action: () -> Unit) {
        button.setOnClickListener {
            if (explained.add(button.id)) Toast.makeText(this, explanation, Toast.LENGTH_LONG).show()
            action()
        }
        button.setOnLongClickListener {
            Toast.makeText(this, explanation, Toast.LENGTH_LONG).show()
            true
        }
    }

    private fun showTools() {
        val menu = PopupMenu(this, toolsButton)
        menu.menu.add(0, MENU_MARK, 0, if (marking) R.string.tools_mark_stop else R.string.tools_mark)
        menu.menu.add(0, MENU_MODEL, 1, if (showModel) R.string.scan_model_hide else R.string.scan_model_show)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                MENU_MARK -> {
                    if (phase != Phase.SCANNING) {
                        Toast.makeText(this, R.string.tools_mark_need_recording, Toast.LENGTH_SHORT).show()
                    } else {
                        setMarking(!marking)
                    }
                }
                MENU_MODEL -> showModel = !showModel
            }
            true
        }
        menu.show()
    }

    /** The ready state ends: recording begins, with the ARCore configuration (torch included) as it is now. */
    /** Tracking, no reconfigure waiting, and the frame clock estimated again after the last one. */
    private fun canRecord(): Boolean =
        trackingNow && torchRequest.get() == null && lightRequest.get() == null && sensorRecorder?.clockReady != false

    private fun startRecording() {
        if (phase != Phase.READY) return
        if (!canRecord()) {
            Toast.makeText(this, R.string.scan_wait_tracking, Toast.LENGTH_SHORT).show()
            return
        }
        torchRequest.set(null)
        lightRequest.set(null)
        phase = Phase.SCANNING
        startedAtElapsed = SystemClock.elapsedRealtime()
        sensorRecorder?.beginRecording()
        ScanCoordinator.state(scan.sessionId, "scanning")
        updateControls()
    }

    /** Back and the arrow ask first when something was recorded. */
    private fun confirmCancel() {
        val recorded = phase == Phase.SCANNING && ((recorder?.selector?.count ?: 0) > 0 || marks.count() > 0)
        if (!recorded) {
            cancelScan()
            return
        }
        android.app.AlertDialog.Builder(this)
            .setTitle(R.string.scan_discard_title)
            .setMessage(R.string.scan_discard_message)
            .setPositiveButton(R.string.scan_discard_confirm) { _, _ -> cancelScan() }
            .setNegativeButton(R.string.scan_discard_keep, null)
            .show()
    }

    // --- GL thread ---

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        background.create()
        overlay.create()
        lines.create()
        coverageOverlay.create()
        edgeOverlay.create()
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
        trackingNow = camera.trackingState == TrackingState.TRACKING
        if (phase == Phase.READY) {
            // Getting ready: tracking and the sensor clocks warm up, nothing is recorded.
            torchRequest.getAndSet(null)?.let { want -> applyTorchWhileReady(session, recorder, want) }
            lightRequest.getAndSet(null)?.let { on -> applyLightWhileReady(session, recorder, on) }
            if (trackingNow) {
                camera.pose.toMatrix(headingPose, 0)
                sensorRecorder?.onFrame(frame.timestamp, headingPose)
            }
        }
        if (phase == Phase.SCANNING) {
            try {
                recorder.onFrame(session, frame, camera)
                if (camera.trackingState == TrackingState.TRACKING) {
                    camera.pose.toMatrix(headingPose, 0)
                    sensorRecorder?.onFrame(frame.timestamp, headingPose)
                }
                pendingTap.getAndSet(null)?.let { tap -> markAt(session, frame, camera, recorder, tap[0], tap[1]) }
            } catch (e: Exception) {
                Log.w(TAG, "Frame processing failed", e)
            }
        }
        if (camera.trackingState == TrackingState.TRACKING) {
            camera.getViewMatrix(view, 0)
            camera.getProjectionMatrix(projection, 0, 0.1f, 100f)
            if (phase == Phase.SCANNING && recorder.guidance.jumpHeld.not()) coverageOverlay.draw(recorder.coverage, view, projection)
            overlay.draw(recorder.overlayPoints, recorder.overlayCount, view, projection)
            camera.pose.toMatrix(edgePose, 0)
            edgeOverlay.draw(recorder.edges.snapshot, showModel, edgePose, view, projection)
            lines.draw(marks.snapshot(), marks.pending(), candidate, view, projection)
        }
        if (progressGate.ready(frame.timestamp)) {
            reportProgress(recorder, camera.trackingState, camera.trackingFailureReason)
        }
    }

    /** The one short line for the pill above the bottom controls, or null when there is nothing to say. */
    private fun guidanceLine(g: ScanRecorder.Guidance, state: TrackingState, failure: TrackingFailureReason): Int? = when {
        phase == Phase.SCANNING && recorder?.selector?.limitReached == true -> R.string.scan_keyframe_limit
        state != TrackingState.TRACKING -> when (failure) {
            TrackingFailureReason.INSUFFICIENT_FEATURES -> R.string.guide_features
            TrackingFailureReason.INSUFFICIENT_LIGHT -> R.string.guide_dark
            TrackingFailureReason.EXCESSIVE_MOTION -> R.string.guide_slow
            TrackingFailureReason.CAMERA_UNAVAILABLE -> null
            else -> R.string.guide_start
        }
        // Ready only: a figure-8 wave during recording would blur keyframes and trip the motion guard.
        phase == Phase.READY && sensorRecorder?.compassNeedsCalibration == true -> R.string.guide_compass
        phase != Phase.SCANNING -> null
        g.tooFast -> R.string.guide_slow
        else -> g.wallSide?.let {
            when (it) {
                WallSide.AHEAD -> R.string.scan_wall_ahead
                WallSide.LEFT -> R.string.scan_wall_left
                WallSide.RIGHT -> R.string.scan_wall_right
                WallSide.BEHIND -> R.string.scan_wall_behind
            }
        }
    }

    /** The short status chip in the top bar. */
    private fun statusLabel(g: ScanRecorder.Guidance, state: TrackingState, failure: TrackingFailureReason): Int = when {
        phase == Phase.FINALIZING -> R.string.scan_saving
        state == TrackingState.TRACKING -> when {
            phase == Phase.READY -> R.string.scan_status_ready
            g.jumpHeld -> R.string.scan_status_lost
            g.tooFast -> R.string.scan_status_move_slower
            else -> R.string.scan_status_tracking
        }
        failure == TrackingFailureReason.INSUFFICIENT_LIGHT -> R.string.scan_status_dark
        failure == TrackingFailureReason.CAMERA_UNAVAILABLE -> R.string.scan_status_camera
        failure == TrackingFailureReason.EXCESSIVE_MOTION -> R.string.scan_status_move_slower
        everTracked -> R.string.scan_status_lost
        else -> R.string.scan_status_point_start
    }

    private fun reportProgress(recorder: ScanRecorder, state: TrackingState, failure: TrackingFailureReason) {
        if (state == TrackingState.TRACKING) everTracked = true
        val scanning = phase == Phase.SCANNING
        val elapsedMs = if (!scanning || startedAtElapsed == 0L) 0L else SystemClock.elapsedRealtime() - startedAtElapsed
        val keyframes = recorder.selector.count
        val planes = recorder.planeCount
        val points = recorder.voxels.size
        val losses = recorder.trajectory.trackingLossCount
        if (scanning) {
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
        }
        runOnUiThread {
            if (phase != Phase.SCANNING && phase != Phase.READY) return@runOnUiThread
            val g = recorder.guidance
            statusText.setText(statusLabel(g, state, failure))
            floorChip.text = g.floorPercent?.let { getString(R.string.scan_floor_chip, it) } ?: getString(R.string.scan_floor_waiting)
            val seconds = elapsedMs / 1000
            counterText.text = resources.getQuantityString(R.plurals.scan_counter, keyframes, keyframes, seconds / 60, seconds % 60)
            val line = guidanceLine(g, state, failure)
            guidanceText.visibility = if (line == null) View.GONE else View.VISIBLE
            line?.let(guidanceText::setText)
            val held = scanning && g.jumpHeld
            resumeCard.visibility = if (held) View.VISIBLE else View.GONE
            if (held) resumeText.setText(if (g.jumpStuck) R.string.scan_jump_stuck else R.string.scan_jump_held)
            if (infoCard.visibility == View.VISIBLE) {
                statsText.text = getString(R.string.scan_info_stats, keyframes, recorder.selector.maxKeyframes, planes, points, losses)
                sensorRecorder?.let { updateSensorsText(it) }
            }
            primaryButton.alpha = if (phase == Phase.READY && !canRecord()) 0.5f else 1f
        }
    }

    /** The preview panel exists only when the page opted in (options.livePreview) and named a trusted origin. */
    private fun setUpLivePreview() {
        // About a third of the width at most, small and semi-transparent; collapsed until the floor chip is tapped.
        val width = resources.displayMetrics.widthPixels / 3
        liveContainer.layoutParams = liveContainer.layoutParams.apply {
            this.width = width
            height = width * 4 / 3
        }
        liveContainer.clipToOutline = true
        if (!scan.options.livePreview) return
        val origin = AppConfig.allowlist.match(scan.liveOrigin) ?: return
        livePanel = LivePanel(liveContainer, AppConfig.allowlist, origin, liveStream, scan.options.locale).also {
            it.show(this)
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
        markUndo.setOnClickListener {
            pendingTap.set(null)
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
        candidate = null
        markPanel.visibility = if (on) View.VISIBLE else View.GONE
        crosshair.visibility = if (on) View.VISIBLE else View.GONE
        updateMarkUi(if (on) R.string.mark_explain else null)
    }

    /** Shows [message], or the next step and the mark count; [detail] goes on a second line. */
    private fun updateMarkUi(message: Int? = null, detail: String? = null) {
        runOnUiThread {
            val pending = marks.pending()
            markKind.isEnabled = pending == null
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

    /**
     * A tap marks the tapped point; when nothing is there to hit, the crosshair at the centre is used instead.
     * One mark per tap: the point is committed at once, and Undo takes the last mark back.
     */
    private fun markAt(session: Session, frame: Frame, camera: com.google.ar.core.Camera, recorder: ScanRecorder, x: Float, y: Float) {
        if (!marking) return
        var refusal = handleMarkTap(session, frame, camera, recorder, x, y)
        if (refusal == Refusal.NO_HIT && viewportWidth > 0) {
            refusal = handleMarkTap(session, frame, camera, recorder, viewportWidth / 2f, viewportHeight / 2f)
        }
        if (refusal == null && candidate != null) confirmCandidate(session, frame, recorder)
    }

    /** GL thread: turns a point on screen into a candidate floor point. Returns why it was refused, or null. */
    private fun handleMarkTap(session: Session, frame: Frame, camera: com.google.ar.core.Camera, recorder: ScanRecorder, x: Float, y: Float): Refusal? {
        if (!marking) return null
        candidate = null
        if (camera.trackingState != TrackingState.TRACKING) {
            updateMarkUi(R.string.mark_not_tracking)
            return Refusal.NOT_TRACKING
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
            return decision.reason
        }
        val accepted = (decision as HitDecision.Accepted).hit
        val plane = hits.getOrNull(candidates.indexOf(accepted))?.trackable as? Plane
        candidate = BasePoint(accepted.pose, plane?.let(recorder::planeIdFor), frame.timestamp)
        return null
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
        livePanel?.destroy()
        livePanel = null
        statusText.setText(R.string.scan_saving)
        ScanCoordinator.state(scan.sessionId, "finalizing")
        for (button in listOf(primaryButton, backButton, torchButton, sensorsButton, locationButton, toolsButton)) button.isEnabled = false
        resumeCard.visibility = View.GONE
        guidanceText.visibility = View.GONE
        crosshair.visibility = View.GONE
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
                SensorCapture(it.orientation, Declination.apply(it.heading, declination), it.fixes, it.pressure, it.timestampSource, it.warnings, it.diagnostics, it.frameClock)
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
                    // The estimate then comes from the best supported segment alone.
                    if (NorthEstimator.estimate(sensorCapture?.heading.orEmpty())?.fromSegment == true) {
                        recorder.warnings.add("true-north-from-segment")
                    }
                }
                // Declined at the page's question, and still off: a user who switched it on later has not declined.
                if (locationDeclined && !sensors.locationEnabled) recorder.warnings.add("location-declined")
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
                    // v1.3: torch state counts and the motion and pose-jump guard events.
                    recorder.guardMetadata().forEach { (key, value) -> put(key, value) }
                    // v1.3: how frame timestamps were mapped onto the sensor clock for heading pairing.
                    sensorCapture?.frameClock?.let { clock ->
                        put("frameClock", buildJsonObject {
                            put("method", clock.method)
                            put("offsetNs", clock.offsetNs)
                            put("minOffsetNs", clock.minOffsetNs)
                            put("maxOffsetNs", clock.maxOffsetNs)
                            put("frames", clock.frames)
                            put("deltaP10Ns", clock.deltaP10Ns)
                            put("deltaP50Ns", clock.deltaP50Ns)
                            put("deltaP90Ns", clock.deltaP90Ns)
                            put("source", "elapsedRealtimeNanos at frame delivery minus frame.timestamp, 10th percentile of the last 60 frames")
                        })
                    }
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
        livePanel?.destroy()
        livePanel = null
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
        private const val INSET_PADDING_DP = 8
        private const val MENU_MARK = 1
        private const val MENU_MODEL = 2

        fun intent(context: Context, sessionId: String): Intent =
            Intent(context, ScanActivity::class.java).putExtra(EXTRA_SESSION_ID, sessionId)

        /** App-private scan storage; never external storage. */
        fun scansRoot(context: Context) = java.io.File(context.filesDir, "scans")
    }
}
