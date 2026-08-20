Building the Android APK (local & CI)

This project contains an Android app under `android_app/` built with Gradle/Kotlin.

CI build (recommended)
- A GitHub Actions workflow is included at `.github/workflows/android-build.yml`.
- It will produce an unsigned release APK artifact and upload it as `sara-android-apk` when run.
- To trigger: push to `main`/`master` or run the workflow manually from the Actions tab.

Local build (developer machine)
1. Install JDK 17 (Temurin/OpenJDK).
2. Install Android SDK and set `ANDROID_SDK_ROOT` environment variable.
   - On Windows, consider using Android Studio to manage SDK and tools.
3. From repository root, run:

```bash
cd android_app
# If you have Gradle installed, generate wrapper once (optional):
gradle wrapper --gradle-version 8.4
# Then build (use wrapper if present):
./gradlew assembleDebug
# or for a release build (unsigned):
./gradlew assembleRelease
```

Notes on signing and publishing
- The CI job produces an unsigned release APK. To publish on Google Play you must sign it with your private keystore.
- For local release builds, configure `android_app/app/signingConfigs` in `app/build.gradle.kts` or pass `-Pandroid.injected.signing.store.file` properties.

If you want, I can:
- Configure signing placeholders (keystore path envvar) in the Gradle build.
- Add a Play Store publishing step (requires secrets).
- Run a build here if you provide an environment with Android SDK and JDK access.
