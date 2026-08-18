package com.sara.companion.features

import android.content.Context
import android.service.notification.StatusBarNotification
import android.app.NotificationManager
import android.app.NotificationChannel
import android.os.Build
import androidx.core.app.NotificationCompat

class NotificationBridge(private val context: Context) {
    private fun ensureChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "sara_companion_calls",
                "SARA Incoming Calls",
                NotificationManager.IMPORTANCE_HIGH
            )
            manager.createNotificationChannel(channel)
        }
    }

    fun listNotifications(): List<String> {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notifications = manager.activeNotifications
        return notifications.map { it.packageName }
    }

    fun dismissNotification(key: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(key.hashCode())
    }

    fun notifyIncomingCall(number: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(manager)
        val notification = NotificationCompat.Builder(context, "sara_companion_calls")
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("Incoming call")
            .setContentText(if (number.isBlank()) "Unknown caller" else number)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        manager.notify(number.hashCode(), notification)
    }
}
