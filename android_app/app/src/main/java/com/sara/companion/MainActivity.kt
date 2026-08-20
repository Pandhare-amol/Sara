package com.sara.companion

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sara.companion.communication.SaraApiClient
import com.sara.companion.features.PhoneAutomationEngine
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private val api = SaraApiClient()
    private val automationEngine = PhoneAutomationEngine(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val statusText = findViewById<TextView>(R.id.statusText)
        val connectButton = findViewById<Button>(R.id.connectButton)

        connectButton.setOnClickListener {
            lifecycleScope.launch {
                val online = api.ping()
                statusText.text = if (online) "SARA Companion Connected" else "SARA Companion Offline"
                if (online) {
                    startService(Intent(this@MainActivity, AutomationService::class.java))
                    automationEngine.runPendingCommands()
                    statusText.text = "SARA Companion Connected"
                }
            }
        }
    }
}
