package com.crosside.synergy.jetbrains.service

import com.crosside.synergy.jetbrains.model.SessionRole
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.util.concurrency.AppExecutorUtil
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.Comparator
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

@Service(Service.Level.PROJECT)
class DocumentSyncService(private val project: Project) : Disposable {
    companion object {
        private val EXCLUDED_DIRS = setOf(".git", ".idea", ".gradle", "build", "out", "node_modules", "release")
        private const val MAX_FILES = 10_000
        private const val MAX_FILE_SIZE = 500 * 1024
        private const val MAX_BATCH_BYTES = 32 * 1024

        fun getInstance(project: Project): DocumentSyncService = project.service()
    }

    private val mapper = ObjectMapper()
    private val scheduler = AppExecutorUtil.createBoundedScheduledExecutorService("CrossIdeDocumentSync", 1)
    private val busConnection = project.messageBus.connect(this)
    private val pendingFullSyncs = ConcurrentHashMap<String, ScheduledFuture<*>>()
    private val suppressUntil = ConcurrentHashMap<String, Long>()
    private val senderId = UUID.randomUUID().toString().substring(0, 8)

    @Volatile private var role: SessionRole = SessionRole.IDLE
    @Volatile private var workspaceSyncing = false
    @Volatile private var sendMessage: ((JsonNode) -> Unit)? = null
    @Volatile private var log: (String) -> Unit = {}

    init {
        registerDocumentListener()
        registerSelectionListener()
        registerFileSystemListener()
    }

    fun activate(role: SessionRole, sender: (JsonNode) -> Unit, logger: (String) -> Unit) {
        this.role = role
        this.sendMessage = sender
        this.log = logger
    }

    fun deactivate() {
        role = SessionRole.IDLE
        workspaceSyncing = false
        sendMessage = null
        pendingFullSyncs.values.forEach { it.cancel(false) }
        pendingFullSyncs.clear()
        suppressUntil.clear()
    }

    fun sendWorkspaceSync() {
        if (role != SessionRole.HOST || workspaceSyncing) return
        val root = projectRoot() ?: return
        workspaceSyncing = true

        scheduler.execute {
            try {
                val files = scanWorkspaceFiles(root)
                if (files.isEmpty()) {
                    log("[Sync] No project files to send")
                    return@execute
                }

                val batches = mutableListOf<List<Pair<String, String>>>()
                var batch = mutableListOf<Pair<String, String>>()
                var batchBytes = 0
                for ((path, content) in files) {
                    val estimated = path.length + content.length + 64
                    if (batch.isNotEmpty() && batchBytes + estimated > MAX_BATCH_BYTES) {
                        batches.add(batch.toList())
                        batch = mutableListOf()
                        batchBytes = 0
                    }
                    batch.add(path to content)
                    batchBytes += estimated
                }
                if (batch.isNotEmpty()) {
                    batches.add(batch.toList())
                }

                batches.forEachIndexed { index, current ->
                    val message = mapper.createObjectNode()
                    message.put("type", "workspace_sync")
                    message.put("batchIndex", index)
                    message.put("totalBatches", batches.size)
                    val filesNode = message.putArray("files")
                    current.forEach { (path, content) ->
                        val node = filesNode.addObject()
                        node.put("filePath", path)
                        node.put("content", content)
                    }
                    sendMessage?.invoke(message)
                    log("[Sync] Sent workspace batch ${index + 1}/${batches.size}")
                }
            } finally {
                scheduler.schedule({ workspaceSyncing = false }, 2, TimeUnit.SECONDS)
            }
        }
    }

    fun sendCurrentFileHint() {
        if (role == SessionRole.IDLE) return
        val selected = FileEditorManager.getInstance(project).selectedFiles.firstOrNull() ?: return
        val relativePath = toRelativePath(selected.path) ?: return
        val message = mapper.createObjectNode()
        message.put("type", "open_file")
        message.put("filePath", relativePath)
        sendMessage?.invoke(message)
    }

    fun handleIncomingMessage(message: JsonNode) {
        when (message.path("type").asText()) {
            "change" -> applyRemoteChange(message)
            "full_sync" -> applyRemoteFullSync(message)
            "request_sync" -> respondWithFullSync(message)
            "workspace_sync" -> applyWorkspaceSync(message)
            "open_file" -> log("[Sync] Peer opened ${message.path("filePath").asText()}")
            "file_event" -> applyRemoteFileEvent(message)
            "cursor" -> log("[Sync] Cursor overlay is not implemented on JetBrains yet")
            "notification" -> log("[Sync] ${message.path("message").asText()}")
        }
    }

    override fun dispose() {
        deactivate()
        scheduler.shutdownNow()
    }

    private fun registerDocumentListener() {
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (role == SessionRole.IDLE || workspaceSyncing) return
                val file = FileDocumentManager.getInstance().getFile(event.document) ?: return
                val relativePath = toRelativePath(file.path) ?: return
                if (isSuppressed(relativePath)) return
                scheduleFullSync(relativePath, event.document)
            }
        }, this)
    }

    private fun registerSelectionListener() {
        busConnection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun selectionChanged(event: FileEditorManagerEvent) {
                if (role == SessionRole.IDLE || workspaceSyncing) return
                val file = event.newFile ?: return
                val relativePath = toRelativePath(file.path) ?: return
                val message = mapper.createObjectNode()
                message.put("type", "open_file")
                message.put("filePath", relativePath)
                sendMessage?.invoke(message)
            }
        })
    }

    private fun registerFileSystemListener() {
        busConnection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: MutableList<out VFileEvent>) {
                if (role == SessionRole.IDLE || workspaceSyncing) return
                for (event in events) {
                    if (event is VFileContentChangeEvent) {
                        continue
                    }
                    when (event) {
                        is VFileCreateEvent -> emitFileEvent("create", event.path, event.isDirectory)
                        is VFileDeleteEvent -> emitFileEvent("delete", event.path, event.file?.isDirectory == true)
                        is VFileMoveEvent -> {
                            val oldPath = "${event.oldParent.path}/${event.file.name}"
                            emitFileEvent("rename", oldPath, event.file.isDirectory, event.file.path)
                        }
                        is VFilePropertyChangeEvent -> {
                            if (event.propertyName == VirtualFile.PROP_NAME) {
                                val parentPath = event.file.parent?.path ?: continue
                                val oldPath = "$parentPath/${event.oldValue}"
                                emitFileEvent("rename", oldPath, event.file.isDirectory, event.file.path)
                            }
                        }
                    }
                }
            }
        })
    }

    private fun scheduleFullSync(relativePath: String, document: Document) {
        pendingFullSyncs.remove(relativePath)?.cancel(false)
        pendingFullSyncs[relativePath] = scheduler.schedule({
            if (role == SessionRole.IDLE || workspaceSyncing || isSuppressed(relativePath)) return@schedule
            val content = ReadAction.compute<String, RuntimeException> { document.text }
            val message = mapper.createObjectNode()
            message.put("type", "full_sync")
            message.put("filePath", relativePath)
            message.put("content", content)
            sendMessage?.invoke(message)
        }, 300, TimeUnit.MILLISECONDS)
    }

    private fun emitFileEvent(eventType: String, absolutePath: String, isDir: Boolean, newAbsolutePath: String? = null) {
        val relativePath = toRelativePath(absolutePath) ?: return
        if (isSuppressed(relativePath)) return

        val message = mapper.createObjectNode()
        message.put("type", "file_event")
        message.put("eventType", eventType)
        message.put("filePath", relativePath)
        message.put("isDir", isDir)
        message.put("senderId", senderId)

        if (!newAbsolutePath.isNullOrBlank()) {
            val newRelativePath = toRelativePath(newAbsolutePath) ?: return
            if (isSuppressed(newRelativePath)) return
            message.put("newFilePath", newRelativePath)
        }

        sendMessage?.invoke(message)
    }

    private fun applyRemoteChange(message: JsonNode) {
        val relativePath = message.path("filePath").asText()
        val file = ensureVirtualFile(relativePath) ?: return
        suppressPath(relativePath, 3_000)

        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project) {
                val document = FileDocumentManager.getInstance().getDocument(file) ?: return@runWriteCommandAction
                val changes = message.path("changes")
                    .map {
                        val start = offsetFor(document, it.path("startLine").asInt(), it.path("startChar").asInt())
                        val end = offsetFor(document, it.path("endLine").asInt(), it.path("endChar").asInt())
                        Triple(start, end, it.path("text").asText())
                    }
                    .sortedByDescending { it.first }
                changes.forEach { (start, end, text) ->
                    document.replaceString(start, end, text)
                }
                FileDocumentManager.getInstance().saveDocument(document)
            }
        }
    }

    private fun applyRemoteFullSync(message: JsonNode) {
        val relativePath = message.path("filePath").asText()
        val file = ensureVirtualFile(relativePath) ?: return
        val content = message.path("content").asText("")
        suppressPath(relativePath, 5_000)

        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project) {
                val document = FileDocumentManager.getInstance().getDocument(file)
                if (document != null) {
                    document.setText(content)
                    FileDocumentManager.getInstance().saveDocument(document)
                } else {
                    Files.writeString(Path.of(file.path), content, StandardCharsets.UTF_8)
                }
            }
        }
    }

    private fun respondWithFullSync(message: JsonNode) {
        val relativePath = message.path("filePath").asText()
        val path = resolvePath(relativePath) ?: return
        if (!Files.exists(path)) return
        val content = Files.readString(path, StandardCharsets.UTF_8)
        val response = mapper.createObjectNode()
        response.put("type", "full_sync")
        response.put("filePath", relativePath)
        response.put("content", content)
        sendMessage?.invoke(response)
    }

    private fun applyWorkspaceSync(message: JsonNode) {
        workspaceSyncing = true
        val files = message.path("files")
        val totalBatches = message.path("totalBatches").asInt(1)
        val batchIndex = message.path("batchIndex").asInt(0)

        for (fileNode in files) {
            val relativePath = fileNode.path("filePath").asText()
            val target = resolvePath(relativePath) ?: continue
            suppressPath(relativePath, 10_000)
            target.parent?.let { Files.createDirectories(it) }
            Files.writeString(target, fileNode.path("content").asText(""), StandardCharsets.UTF_8)
        }

        refreshProjectRoot()
        if (batchIndex >= totalBatches - 1) {
            scheduler.schedule({ workspaceSyncing = false }, 2, TimeUnit.SECONDS)
        }
    }

    private fun applyRemoteFileEvent(message: JsonNode) {
        val relativePath = message.path("filePath").asText()
        val target = resolvePath(relativePath) ?: return
        val newRelativePath = message.path("newFilePath").takeIf { !it.isMissingNode && !it.isNull }?.asText()

        suppressPath(relativePath, 5_000)
        if (!newRelativePath.isNullOrBlank()) suppressPath(newRelativePath, 5_000)

        when (message.path("eventType").asText()) {
            "create" -> {
                if (message.path("isDir").asBoolean(false)) {
                    Files.createDirectories(target)
                } else {
                    target.parent?.let { Files.createDirectories(it) }
                    if (!Files.exists(target)) Files.writeString(target, "", StandardCharsets.UTF_8)
                }
            }
            "delete" -> deletePath(target)
            "rename" -> {
                val destination = resolvePath(newRelativePath ?: return) ?: return
                destination.parent?.let { Files.createDirectories(it) }
                if (Files.exists(target)) {
                    Files.move(target, destination, StandardCopyOption.REPLACE_EXISTING)
                }
            }
        }

        refreshProjectRoot()
    }

    private fun offsetFor(document: Document, line: Int, column: Int): Int {
        if (document.lineCount <= 0) return 0
        val safeLine = line.coerceIn(0, document.lineCount - 1)
        val lineStart = document.getLineStartOffset(safeLine)
        val lineEnd = document.getLineEndOffset(safeLine)
        return (lineStart + column).coerceIn(lineStart, lineEnd)
    }

    private fun ensureVirtualFile(relativePath: String): VirtualFile? {
        val path = resolvePath(relativePath) ?: return null
        path.parent?.let { Files.createDirectories(it) }
        if (!Files.exists(path)) Files.writeString(path, "", StandardCharsets.UTF_8)
        refreshProjectRoot()
        return LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path)
    }

    private fun scanWorkspaceFiles(root: Path): List<Pair<String, String>> {
        val results = mutableListOf<Pair<String, String>>()
        if (!Files.exists(root)) return results

        Files.walk(root).use { stream ->
            stream.filter { Files.isRegularFile(it) }
                .filter { shouldIncludeFile(root, it) }
                .limit(MAX_FILES.toLong())
                .forEach { path ->
                    runCatching {
                        if (Files.size(path) > MAX_FILE_SIZE) return@runCatching
                        val content = Files.readString(path, StandardCharsets.UTF_8)
                        if (content.indexOf('\u0000') >= 0) return@runCatching
                        results.add(root.relativize(path).toString().replace('\\', '/') to content)
                    }.onFailure {
                        log("[Sync] Skipped unreadable file ${path.fileName}")
                    }
                }
        }

        return results
    }

    private fun shouldIncludeFile(root: Path, path: Path): Boolean {
        val relative = root.relativize(path).toString().replace('\\', '/')
        if (relative.split('/').any { it in EXCLUDED_DIRS }) return false
        if (relative.endsWith(".zip") || relative.endsWith(".jar") || relative.endsWith(".vsix") || relative.endsWith(".map")) return false
        return true
    }

    private fun deletePath(path: Path) {
        if (!Files.exists(path)) return
        Files.walk(path)
            .sorted(Comparator.reverseOrder())
            .forEach { Files.deleteIfExists(it) }
    }

    private fun projectRoot(): Path? = project.basePath?.let { Path.of(it) }

    private fun resolvePath(relativePath: String): Path? {
        return projectRoot()?.resolve(relativePath.replace('/', File.separatorChar))
    }

    private fun toRelativePath(absolutePath: String): String? {
        val root = projectRoot()?.toAbsolutePath()?.normalize() ?: return null
        val fullPath = Path.of(absolutePath).toAbsolutePath().normalize()
        if (!fullPath.startsWith(root)) return null
        val relative = root.relativize(fullPath).toString().replace('\\', '/')
        if (relative.split('/').any { it in EXCLUDED_DIRS }) return null
        return relative
    }

    private fun refreshProjectRoot() {
        projectRoot()?.let { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(it) }
    }

    private fun suppressPath(relativePath: String, durationMs: Long) {
        if (relativePath.isBlank()) return
        suppressUntil[relativePath] = System.currentTimeMillis() + durationMs
    }

    private fun isSuppressed(relativePath: String): Boolean {
        val expiry = suppressUntil[relativePath] ?: return false
        if (System.currentTimeMillis() <= expiry) return true
        suppressUntil.remove(relativePath)
        return false
    }
}
