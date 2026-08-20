package com.sara.companion.features

import android.content.Context
import android.service.notification.StatusBarNotification
import android.app.NotificationManager

class NotificationBridge(private val context: Context) {
    fun listNotifications(): List<String> {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notifications = manager.activeNotifications
        return notifications.map { it.packageName }
    }

    fun dismissNotification(key: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(key.hashCode())
    }
}
