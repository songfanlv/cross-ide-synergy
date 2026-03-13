package com.crosside.synergy.jetbrains.ui

import com.crosside.synergy.jetbrains.actions.CrossIdeActionSupport
import com.crosside.synergy.jetbrains.model.SessionRole
import com.crosside.synergy.jetbrains.model.SessionSnapshot
import com.crosside.synergy.jetbrains.service.CrossIdeSessionService
import com.intellij.openapi.Disposable
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.datatransfer.StringSelection
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel

class CrossIdeToolWindowPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {
    private val sessionService = CrossIdeSessionService.getInstance(project)
    private val shareButton = JButton("Share")
    private val joinButton = JButton("Join")
    private val disconnectButton = JButton("Disconnect")
    private val copyButton = JButton("Copy Code")
    private val roleValue = JLabel("Idle")
    private val shareCodeField = JBTextField().apply { isEditable = false }
    private val remoteClientsValue = JLabel("0")
    private val connectionValue = JLabel("Offline")
    private val logArea = JBTextArea()
    private val stateDisposable = sessionService.addStateListener(::updateState)
    private val logDisposable = sessionService.addLogListener(::appendLog)

    init {
        border = JBUI.Borders.empty(12)
        add(buildToolbar(), BorderLayout.NORTH)
        add(buildDetails(), BorderLayout.CENTER)
        add(buildLogPanel(), BorderLayout.SOUTH)
        installHandlers()
        updateState(sessionService.currentSnapshot())
    }

    override fun dispose() {
        stateDisposable.dispose()
        logDisposable.dispose()
    }

    private fun buildToolbar(): JPanel {
        return JPanel(FlowLayout(FlowLayout.LEFT, 8, 0)).apply {
            add(shareButton)
            add(joinButton)
            add(disconnectButton)
            add(copyButton)
        }
    }

    private fun buildDetails(): JPanel {
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Role:", roleValue)
            .addLabeledComponent("Share Code:", shareCodeField)
            .addLabeledComponent("Remote Clients:", remoteClientsValue)
            .addLabeledComponent("Sidecar / Cloud:", connectionValue)
            .panel
    }

    private fun buildLogPanel(): JPanel {
        logArea.isEditable = false
        logArea.rows = 14
        val panel = JPanel(BorderLayout())
        panel.border = JBUI.Borders.emptyTop(12)
        panel.add(JLabel("Activity"), BorderLayout.NORTH)
        panel.add(JBScrollPane(logArea), BorderLayout.CENTER)
        return panel
    }

    private fun installHandlers() {
        shareButton.addActionListener {
            CrossIdeActionSupport.share(project)
        }

        joinButton.addActionListener {
            val shareCode = Messages.showInputDialog(
                project,
                "Enter the 6-character share code from the host",
                "Join Cross-IDE Session",
                Messages.getQuestionIcon()
            )?.trim()?.uppercase()

            if (!shareCode.isNullOrBlank()) {
                CrossIdeActionSupport.join(project, shareCode)
            }
        }

        disconnectButton.addActionListener {
            CrossIdeActionSupport.disconnect(project)
        }

        copyButton.addActionListener {
            val shareCode = shareCodeField.text.trim()
            if (shareCode.isNotBlank()) {
                CopyPasteManager.getInstance().setContents(StringSelection(shareCode))
            }
        }
    }

    private fun updateState(snapshot: SessionSnapshot) {
        roleValue.text = snapshot.role.presentableName()
        shareCodeField.text = snapshot.shareCode.orEmpty()
        remoteClientsValue.text = snapshot.remoteClients.toString()
        connectionValue.text = if (snapshot.sidecarConnected) {
            if (snapshot.cloudConnected) "Connected / Cloud Ready" else "Connected / Cloud Pending"
        } else {
            "Offline"
        }

        shareButton.isEnabled = snapshot.role == SessionRole.IDLE
        joinButton.isEnabled = snapshot.role == SessionRole.IDLE
        disconnectButton.isEnabled = snapshot.role != SessionRole.IDLE
        copyButton.isEnabled = snapshot.shareCode?.isNotBlank() == true
    }

    private fun appendLog(line: String) {
        if (logArea.text.isNotBlank()) {
            logArea.append("\n")
        }
        logArea.append(line)
        logArea.caretPosition = logArea.document.length
    }
}
