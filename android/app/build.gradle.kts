plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "app.homecast.android"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.homecast.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }
    buildTypes {
        release {
            // Sideload-ready: minified with R8 and signed with the debug key until a real keystore is configured.
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    // Minified like release, but debuggable so the test hooks (autologin, browse dump) are available.
    buildTypes.create("staging") {
        initWith(buildTypes.getByName("release"))
        isDebuggable = true
        matchingFallbacks += listOf("release")
    }
    sourceSets.getByName("staging").java.srcDir("src/debug/kotlin")
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
}

dependencies {
    implementation(project(":contract"))
    implementation(project(":core"))
    implementation(project(":playback"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.coil.compose)
    implementation(libs.coil.okhttp)
    implementation(libs.okhttp)
    implementation(libs.workmanager)
    debugImplementation(libs.media3.session)
    debugImplementation(libs.coroutines.guava)
    "stagingImplementation"(libs.media3.session)
    "stagingImplementation"(libs.coroutines.guava)
    debugImplementation(libs.compose.ui.tooling)
}
