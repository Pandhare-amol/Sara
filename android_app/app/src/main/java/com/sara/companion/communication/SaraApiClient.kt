package com.sara.companion.communication

import com.sara.companion.core.CompanionConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class SaraApiClient {
    suspend fun ping(): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = URL("${CompanionConfig.SERVER_BASE_URL}/health")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 3_000
            conn.readTimeout = 3_000
            conn.requestMethod = "GET"
            conn.responseCode in 200..299
        } catch (_: Exception) {
            false
        }
    }

    suspend fun sendCommand(action: String, payload: Map<String, Any?>): JSONObject = withContext(Dispatchers.IO) {
        val body = JSONObject(payload).toString()
        val url = URL("${CompanionConfig.SERVER_BASE_URL}/execute")
        val conn = url.openConnection() as HttpURLConnection
        conn.doOutput = true
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val response = conn.inputStream.bufferedReader().use { it.readText() }
        JSONObject(response)
    }
}
