package com.sara.companion.features

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.provider.Settings
import com.sara.companion.communication.CompanionCommandClient
import com.sara.companion.model.CompanionCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class PhoneAutomationEngine(private val context: Context) {
    private val deviceController = DeviceController(context)
    private val commandClient = CompanionCommandClient(context)

    fun runPendingCommands() {
        CoroutineScope(Dispatchers.Main).launch {
            val commands = commandClient.fetchPendingCommands()
            commands.forEach { command ->
                execute(command)
                commandClient.reportResult(command, true)
            }
        }
    }

    private fun execute(command: CompanionCommand) {
        when (command.action) {
            "flashlight" -> deviceController.toggleFlashlight(command.value as? Boolean ?: true)
            "brightness" -> deviceController.setBrightness((command.value as? Number)?.toInt() ?: 50)
            "volume" -> deviceController.setVolume((command.value as? Number)?.toInt() ?: 10)
            "vibrate" -> deviceController.vibrate()
            "sms" -> launchIntent(Intent(Intent.ACTION_VIEW).setType("vnd.android-dir/mms-sms"))
            "calls" -> launchIntent(Intent(Intent.ACTION_DIAL))
            "whatsapp" -> launchApp("com.whatsapp")
            "telegram" -> launchApp("org.telegram.messenger")
            "instagram" -> launchApp("com.instagram.android")
            "gallery" -> launchIntent(Intent(Intent.ACTION_VIEW, MediaStore.Images.Media.EXTERNAL_CONTENT_URI))
            "files" -> launchIntent(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://"), "*/*"))
            "notifications" -> launchIntent(Intent(Settings.ACTION_NOTIFICATION_SETTINGS))
            else -> deviceController.notifyUser("Unsupported command: ${command.action}")
        }
    }

    private fun launchApp(packageName: String) {
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } else {
            deviceController.notifyUser("App is not installed: $packageName")
        }
    }

    private fun launchIntent(intent: Intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
