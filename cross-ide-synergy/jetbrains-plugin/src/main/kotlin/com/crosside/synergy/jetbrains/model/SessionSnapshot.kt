package com.crosside.synergy.jetbrains.model

data class SessionSnapshot(
    val role: SessionRole = SessionRole.IDLE,
    val shareCode: String? = null,
    val remoteClients: Int = 0,
    val localClients: Int = 0,
    val sidecarConnected: Boolean = false,
    val cloudConnected: Boolean = false,
    val lastMessage: String = "Ready"
)
