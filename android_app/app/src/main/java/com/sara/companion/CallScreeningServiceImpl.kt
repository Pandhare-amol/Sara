package com.sara.companion

import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log
import androidx.core.app.NotificationCompat
import com.sara.companion.features.NotificationBridge

class CallScreeningServiceImpl : CallScreeningService() {
    override fun onScreenCall(details: Call.Details) {
        val handle = details.handle?.schemeSpecificPart ?: "unknown"
        Log.i("SARA", "Incoming call screened: $handle")

        val shouldAllow = true
        val response = CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
            .setSkipCallLog(false)
            .setSkipNotification(false)
            .build()

        if (!shouldAllow) {
            response
        }

        val bridge = NotificationBridge(this)
        bridge.notifyIncomingCall(handle)
        respondToCall(details, response)
    }
}
