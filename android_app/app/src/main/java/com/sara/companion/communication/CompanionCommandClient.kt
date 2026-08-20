package com.sara.companion.communication

import android.content.Context
import com.sara.companion.core.CompanionConfig
import com.sara.companion.model.CompanionCommand
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class CompanionCommandClient(private val context: Context) {
    private var registeredDeviceId: String? = null

    suspend fun fetchPendingCommands(): List<CompanionCommand> = withContext(Dispatchers.IO) {
        try {
            val deviceId = ensurePairedDevice()
            val url = URL("${CompanionConfig.SERVER_BASE_URL}/companion/pending/$deviceId")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 3_000
            conn.readTimeout = 3_000
            conn.requestMethod = "GET"
            if (conn.responseCode !in 200..299) return@withContext emptyList()
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val items = json.optJSONArray("result") ?: return@withContext emptyList()
            val result = mutableListOf<CompanionCommand>()
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                result.add(
                    CompanionCommand(
                        action = item.optString("action", "noop"),
                        value = item.opt("value"),
                        id = item.optString("id", "")
                    )
                )
            }
            result
        } catch (_: Exception) {
            emptyList()
        }
    }

    suspend fun reportResult(command: CompanionCommand, success: Boolean) = withContext(Dispatchers.IO) {
        val deviceId = registeredDeviceId ?: ensurePairedDevice()
        val payload = JSONObject()
        payload.put("device_id", deviceId)
        payload.put("command_id", command.id)
        payload.put("success", success)
        val url = URL("${CompanionConfig.SERVER_BASE_URL}/companion/result")
        val conn = url.openConnection() as HttpURLConnection
        conn.doOutput = true
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
    }

    private suspend fun ensurePairedDevice(): String = withContext(Dispatchers.IO) {
        registeredDeviceId?.let { return@withContext it }
        val payload = JSONObject()
        payload.put("name", CompanionConfig.DEVICE_NAME)
        payload.put("token", CompanionConfig.AUTH_TOKEN)
        val conn = URL("${CompanionConfig.SERVER_BASE_URL}/companion/pair").openConnection() as HttpURLConnection
        conn.doOutput = true
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        val response = JSONObject(body)
        val device = response.optJSONObject("result") ?: JSONObject()
        val id = device.optString("id")
        registeredDeviceId = id
        id
    }
}
