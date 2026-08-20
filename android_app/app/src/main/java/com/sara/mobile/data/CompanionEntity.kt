package com.sara.mobile.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "companion_history")
data class CompanionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val message: String,
    val createdAt: Long = System.currentTimeMillis()
)
