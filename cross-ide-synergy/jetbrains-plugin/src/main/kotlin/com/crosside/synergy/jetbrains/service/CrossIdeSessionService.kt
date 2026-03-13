package com.crosside.synergy.jetbrains.service

import com.crosside.synergy.jetbrains.model.SessionRole
import com.crosside.synergy.jetbrains.model.SessionSnapshot
import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CopyOnWriteArrayList

@Service(Service.Level.PROJECT)
class CrossIdeSessionService(private val project: Project) : Disposable {
    companion object {
        private val TIME_FORMAT = DateTimeFormatter.ofPattern("HH:mm:ss")

        fun getInstance(project: Project): CrossIdeSessionService = project.service()
    }

    private val sidecar = SidecarService.getInstance(project)
    private val documentSync = DocumentSyncService.getInstance(project)
    private val stateListeners = CopyOnWriteArrayList<(SessionSnapshot) -> Unit>()
    private val logListeners = CopyOnWriteArrayList<(String) -> Unit>()
    private val sidecarListener = sidecar.addMessageListener(::handleAgentMessage)

    @Volatile
    private var snapshot = SessionSnapshot()

    fun currentSnapshot(): SessionSnapshot = snapshot

    fun addStateListener(listener: (SessionSnapshot) -> Unit): Disposable {
        stateListeners.add(listener)
        listener(snapshot)
        return Disposable { stateListeners.remove(listener) }
    }

    fun addLogListener(listener: (String) -> Unit): Disposable {
        logListeners.add(listener)
        return Disposable { logListeners.remove(listener) }
    }

    fun appendLog(message: String) {
        val line = "[${LocalTime.now().format(TIME_FORMAT)}] $message"
        logListeners.forEach { listener ->
            ApplicationManager.getApplication().invokeLater {
                listener(line)
            }
        }
    }

    fun startHosting(): String {
        requireProjectRoot()
        sidecar.ensureConnected(::appendLog)
        val result = sidecar.callRpc("start_host")
        val shareCode = result.path("shareCode").asText()

        documentSync.activate(SessionRole.HOST, sidecar::sendMessage, ::appendLog)
        updateSnapshot(
            snapshot.copy(
                role = SessionRole.HOST,
                shareCode = shareCode,
                remoteClients = 0,
                sidecarConnected = true,
                lastMessage = "Hosting session"
            )
        )
        appendLog("[Host] Session started with share code $shareCode")
        refreshStatus()
        return shareCode
    }

    fun joinSession(shareCode: String) {
        requireProjectRoot()
        sidecar.ensureConnected(::appendLog)
        val normalized = shareCode.trim().uppercase()
        sidecar.callRpc("start_guest", mapOf("shareCode" to normalized))

        documentSync.activate(SessionRole.GUEST, sidecar::sendMessage, ::appendLog)
        updateSnapshot(
            snapshot.copy(
                role = SessionRole.GUEST,
                shareCode = normalized,
                sidecarConnected = true,
                lastMessage = "Connected as guest"
            )
        )
        appendLog("[Guest] Joined session $normalized")
        refreshStatus()
    }

    fun disconnect() {
        try {
            if (snapshot.role != SessionRole.IDLE && sidecar.isConnected()) {
                sidecar.callRpc("stop_session")
            }
        } finally {
            documentSync.deactivate()
            updateSnapshot(
                SessionSnapshot(
                    role = SessionRole.IDLE,
                    lastMessage = "Disconnected",
                    sidecarConnected = sidecar.isConnected()
                )
            )
            appendLog("[System] Collaboration session closed")
        }
    }

    fun refreshStatus() {
        if (!sidecar.isConnected()) {
            updateSnapshot(snapshot.copy(sidecarConnected = false, cloudConnected = false))
            return
        }

        val status = sidecar.callRpc("get_status")
        updateSnapshot(
            snapshot.copy(
                role = SessionRole.fromAgentValue(status.path("role").takeIf { !it.isNull }?.asText()),
                shareCode = status.path("shareCode").takeIf { !it.isNull }?.asText(),
                remoteClients = status.path("remoteClients").asInt(0),
                localClients = status.path("localClients").asInt(0),
                sidecarConnected = true,
                cloudConnected = status.path("isCloudConnected").asBoolean(false)
            )
        )
    }

    override fun dispose() {
        documentSync.deactivate()
        sidecarListener.dispose()
    }

    private fun handleAgentMessage(message: JsonNode) {
        when (message.path("type").asText()) {
            "session_event" -> handleSessionEvent(message)
            else -> if (snapshot.role != SessionRole.IDLE) {
                documentSync.handleIncomingMessage(message)
            }
        }
    }

    private fun handleSessionEvent(message: JsonNode) {
        val event = message.path("event").asText()
        val guestId = message.path("guestId").asText("unknown")

        when (event) {
            "join" -> {
                if (snapshot.role == SessionRole.HOST) {
                    updateSnapshot(snapshot.copy(remoteClients = snapshot.remoteClients + 1, lastMessage = "Guest connected"))
                    ApplicationManager.getApplication().executeOnPooledThread {
                        documentSync.sendWorkspaceSync()
                        documentSync.sendCurrentFileHint()
                    }
                }
                appendLog("[Session] Guest joined: $guestId")
            }
            "leave" -> {
                if (snapshot.role == SessionRole.HOST) {
                    updateSnapshot(snapshot.copy(remoteClients = (snapshot.remoteClients - 1).coerceAtLeast(0), lastMessage = "Guest disconnected"))
                }
                appendLog("[Session] Guest left: $guestId")
            }
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { refreshStatus() }
        }
    }

    private fun updateSnapshot(newSnapshot: SessionSnapshot) {
        snapshot = newSnapshot
        stateListeners.forEach { listener ->
            ApplicationManager.getApplication().invokeLater {
                listener(newSnapshot)
            }
        }
    }

    private fun requireProjectRoot() {
        check(!project.basePath.isNullOrBlank()) {
            "Open a project folder before starting Cross-IDE collaboration."
        }
    }
}
