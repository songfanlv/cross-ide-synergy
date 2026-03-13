package com.crosside.synergy.jetbrains.model

enum class SessionRole {
    IDLE,
    HOST,
    GUEST;

    fun presentableName(): String = when (this) {
        IDLE -> "Idle"
        HOST -> "Host"
        GUEST -> "Guest"
    }

    companion object {
        fun fromAgentValue(value: String?): SessionRole = when (value?.lowercase()) {
            "host" -> HOST
            "guest" -> GUEST
            else -> IDLE
        }
    }
}
