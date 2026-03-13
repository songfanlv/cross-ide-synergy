package com.crosside.synergy.jetbrains.actions

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.ui.Messages

class JoinSessionAction : DumbAwareAction("Join Session") {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val shareCode = Messages.showInputDialog(
            project,
            "Enter the 6-character share code from the host",
            "Join Cross-IDE Session",
            Messages.getQuestionIcon()
        )?.trim()?.uppercase()

        if (shareCode.isNullOrBlank()) {
            return
        }

        CrossIdeActionSupport.join(project, shareCode)
    }
}
