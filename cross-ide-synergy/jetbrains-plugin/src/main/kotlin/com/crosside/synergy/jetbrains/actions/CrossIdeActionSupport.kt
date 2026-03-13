package com.crosside.synergy.jetbrains.actions

import com.crosside.synergy.jetbrains.CrossIdeNotifier
import com.crosside.synergy.jetbrains.service.CrossIdeSessionService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import java.awt.datatransfer.StringSelection

object CrossIdeActionSupport {
    fun share(project: Project) {
        runTask(project, "Starting Cross-IDE Host") { indicator ->
            indicator.text = "Connecting to Cross-IDE sidecar"
            val shareCode = CrossIdeSessionService.getInstance(project).startHosting()
            ApplicationManager.getApplication().invokeLater {
                CopyPasteManager.getInstance().setContents(StringSelection(shareCode))
                CrossIdeNotifier.info(project, "Share code $shareCode copied to clipboard.")
            }
        }
    }

    fun join(project: Project, shareCode: String) {
        runTask(project, "Joining Cross-IDE Session") { indicator ->
            indicator.text = "Joining session $shareCode"
            CrossIdeSessionService.getInstance(project).joinSession(shareCode)
            ApplicationManager.getApplication().invokeLater {
                CrossIdeNotifier.info(project, "Joined session $shareCode.")
            }
        }
    }

    fun disconnect(project: Project) {
        runTask(project, "Disconnecting Cross-IDE Session") { indicator ->
            indicator.text = "Stopping collaboration session"
            CrossIdeSessionService.getInstance(project).disconnect()
            ApplicationManager.getApplication().invokeLater {
                CrossIdeNotifier.info(project, "Cross-IDE session stopped.")
            }
        }
    }

    private fun runTask(project: Project, title: String, work: (ProgressIndicator) -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    work(indicator)
                } catch (t: Throwable) {
                    CrossIdeSessionService.getInstance(project).appendLog("[UI] ${t.message ?: t.javaClass.simpleName}")
                    ApplicationManager.getApplication().invokeLater {
                        CrossIdeNotifier.error(project, t.message ?: "Cross-IDE action failed.")
                    }
                    throw t
                }
            }
        })
    }
}
