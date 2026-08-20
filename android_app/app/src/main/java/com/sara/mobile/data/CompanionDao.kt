package com.sara.mobile.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface CompanionDao {
    @Query("SELECT * FROM companion_history ORDER BY createdAt DESC")
    suspend fun getHistory(): List<CompanionEntity>

    @Insert
    suspend fun insert(item: CompanionEntity)
}
