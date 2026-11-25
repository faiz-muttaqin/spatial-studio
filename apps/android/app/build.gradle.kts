import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Origins are validated here so a typo fails the build instead of producing an
// app that trusts the wrong host.
fun requireOrigin(name: String, value: String, debugOnly: Boolean): String {
    val uri = runCatching { URI(value) }.getOrNull()
        ?: throw GradleException("$name is not a valid URI: $value")
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    if (host.isNullOrEmpty() || uri.userInfo != null || !uri.path.isNullOrEmpty() ||
        uri.query != null || uri.fragment != null
    ) {
        throw GradleException("$name must be a bare origin like https://host[:port], got: $value")
    }
    val loopback = host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2"
    when {
        scheme == "https" -> Unit
        scheme == "http" && debugOnly && loopback -> Unit
        else -> throw GradleException("$name must use https (http is allowed only for a debug loopback origin): $value")
    }
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return "$scheme://$host$port"
}

val studioOrigin = requireOrigin(
    "studioOrigin",
    providers.gradleProperty("studioOrigin").get(),
    debugOnly = false,
)
val devOrigin = requireOrigin(
    "devOrigin",
    providers.gradleProperty("devOrigin").get(),
    debugOnly = true,
)

android {
    namespace = "com.faizmuttaqin.spatialstudio"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.faizmuttaqin.spatialstudio"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "STUDIO_ORIGIN", "\"$studioOrigin\"")
        buildConfigField("String", "DEV_ORIGIN", "\"\"")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("String", "DEV_ORIGIN", "\"$devOrigin\"")
        }
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

dependencies {
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.arcore)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
}
