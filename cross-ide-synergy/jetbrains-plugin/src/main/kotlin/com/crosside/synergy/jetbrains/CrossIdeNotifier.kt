package com.crosside.synergy.jetbrains

import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.notification.NotificationGroupManager
import com.intellij.openapi.project.Project

object CrossIdeNotifier {
    private const val GROUP_ID = "Cross-IDE Synergy"

    fun info(project: Project?, message: String) {
        notify(project, message, NotificationType.INFORMATION)
    }

    fun warn(project: Project?, message: String) {
        notify(project, message, NotificationType.WARNING)
    }

    fun error(project: Project?, message: String) {
        notify(project, message, NotificationType.ERROR)
    }

    private fun notify(project: Project?, message: String, type: NotificationType) {
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification(message, type)
        Notifications.Bus.notify(notification, project)
    }
}
