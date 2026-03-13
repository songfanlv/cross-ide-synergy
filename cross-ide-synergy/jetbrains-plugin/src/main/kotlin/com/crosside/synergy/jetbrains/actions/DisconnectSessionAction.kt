package com.crosside.synergy.jetbrains.actions

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction

class DisconnectSessionAction : DumbAwareAction("Disconnect") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        CrossIdeActionSupport.disconnect(project)
    }
}
