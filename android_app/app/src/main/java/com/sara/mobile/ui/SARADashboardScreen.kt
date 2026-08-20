package com.sara.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun SARADashboardScreen() {
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text("SARA Mobile", style = MaterialTheme.typography.headlineMedium)
        }
        item {
            Card(modifier = Modifier.padding(vertical = 4.dp)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Desktop Connection", style = MaterialTheme.typography.titleMedium)
                    Text("Connected to SARA desktop companion")
                }
            }
        }
        item {
            Card(modifier = Modifier.padding(vertical = 4.dp)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Quick Actions", style = MaterialTheme.typography.titleMedium)
                    Text("Flashlight, Volume, Brightness, Notifications")
                }
            }
        }
        item {
            Card(modifier = Modifier.padding(vertical = 4.dp)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Active Tasks", style = MaterialTheme.typography.titleMedium)
                    Text("Idle")
                }
            }
        }
        items(listOf("Battery: 85%", "Storage: 128 GB available", "Voice: English/Marathi")) { item ->
            Card(modifier = Modifier.padding(vertical = 4.dp)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(item)
                }
            }
        }
    }
}
