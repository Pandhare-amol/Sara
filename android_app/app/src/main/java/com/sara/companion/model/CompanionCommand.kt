package com.sara.companion.model

data class CompanionCommand(
    val action: String,
    val value: Any? = null,
    val id: String = ""
)
