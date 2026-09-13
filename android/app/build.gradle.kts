import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repoRoot = projectDir.parentFile.parentFile
val generatedAssets = layout.buildDirectory.dir("generated/assets/main")

android {
    namespace = "com.local.cognitiontrainer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.local.cognitiontrainer"
        minSdk = 26
        targetSdk = 34
        versionCode = 53
        versionName = "2.51"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("../src")
            res.srcDirs("../res")
            manifest.srcFile("../AndroidManifest.xml")
            assets.srcDir(generatedAssets)
        }
    }

    signingConfigs {
        getByName("debug") {
            val legacy = File("E:/android-build/debug.keystore")
            if (legacy.isFile) {
                storeFile = legacy
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }
    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions { jvmTarget = "11" }
    packaging {
        jniLibs.useLegacyPackaging = true
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

tasks.register("syncOfflineAssets") {
    val source = repoRoot.resolve("认知训练-离线版.html")
    val outDir = generatedAssets.map { it.asFile }
    inputs.file(source)
    outputs.dir(outDir)
    doLast {
        check(source.isFile) { "找不到离线 HTML：$source，请先运行 build_offline.py" }
        val destination = File(outDir.get(), "index.html")
        destination.parentFile.mkdirs()
        source.copyTo(destination, overwrite = true)
    }
}

tasks.named("preBuild") { dependsOn("syncOfflineAssets") }

dependencies {
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.20")
    implementation("androidx.activity:activity:1.9.2")
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel:2.8.4")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

