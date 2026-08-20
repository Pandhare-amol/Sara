package com.sara.companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.sara.companion.features.DeviceController
import com.sara.companion.features.PhoneAutomationEngine

class AutomationService : Service() {
    private lateinit var deviceController: DeviceController
    private lateinit var automationEngine: PhoneAutomationEngine

    override fun onCreate() {
        super.onCreate()
        deviceController = DeviceController(this)
        automationEngine = PhoneAutomationEngine(this)
        createNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, "sara_companion")
            .setContentTitle("SARA Companion")
            .setContentText("Automation service is running")
            .setSmallIcon(android.R.drawable.ic_menu_send)
            .build()
        startForeground(1, notification)
        deviceController.notifyUser("SARA Companion service started")
        automationEngine.runPendingCommands()
        return START_STICKY
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "sara_companion",
                "SARA Companion",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
