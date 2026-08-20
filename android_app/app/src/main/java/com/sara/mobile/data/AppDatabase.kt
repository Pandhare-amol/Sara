package com.sara.mobile.data

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(entities = [CompanionEntity::class], version = 1)
abstract class AppDatabase : RoomDatabase() {
    abstract fun companionDao(): CompanionDao
}
