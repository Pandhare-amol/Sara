package com.sara.companion

import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sara.companion.communication.SaraApiClient
import com.sara.companion.features.PhoneAutomationEngine
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private val api = SaraApiClient()
    private val automationEngine = PhoneAutomationEngine(this)
    private var statusText: TextView? = null
    private var roleText: TextView? = null
    private var connectButton: Button? = null
    private var roleButton: Button? = null

    private val requestCallScreeningRole = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        refreshRoleState()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        roleText = findViewById(R.id.roleText)
        connectButton = findViewById(R.id.connectButton)
        roleButton = findViewById(R.id.roleButton)

        connectButton?.setOnClickListener {
            lifecycleScope.launch {
                val online = api.ping()
                statusText?.text = if (online) "SARA Companion Connected" else "SARA Companion Offline"
                if (online) {
                    startService(Intent(this@MainActivity, AutomationService::class.java))
                    automationEngine.runPendingCommands()
                    statusText?.text = "SARA Companion Connected"
                }
            }
        }

        roleButton?.setOnClickListener {
            requestCallScreeningRole()
        }

        refreshRoleState()
    }

    private fun refreshRoleState() {
        val granted = isCallScreeningRoleGranted()
        roleText?.text = if (granted) {
            "Call screening role: granted"
        } else {
            "Call screening role: not granted"
        }
        roleButton?.isEnabled = !granted
        roleButton?.text = if (granted) "Role already granted" else "Grant call screening role"
    }

    private fun requestCallScreeningRole() {
        if (isCallScreeningRoleGranted()) {
            refreshRoleState()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java)
            val intent = roleManager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
            requestCallScreeningRole.launch(intent)
        } else {
            roleText?.text = "Call screening role needs Android 10 or newer"
        }
    }

    private fun isCallScreeningRoleGranted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return false
        }
        val roleManager = getSystemService(RoleManager::class.java)
        return roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
    }
}
