package com.crosside.synergy.jetbrains.service

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.extensions.PluginId
import com.intellij.util.concurrency.AppExecutorUtil
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

@Service(Service.Level.PROJECT)
class SidecarService : Disposable {
    companion object {
        private const val PLUGIN_ID = "com.crosside.synergy.jetbrains"
        private const val PORT = 36969

        fun getInstance(project: com.intellij.openapi.project.Project): SidecarService = project.service()
    }

    private val mapper = ObjectMapper()
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()
    private val scheduler = AppExecutorUtil.createBoundedScheduledExecutorService("CrossIdeSidecar", 1)
    private val listeners = CopyOnWriteArrayList<(JsonNode) -> Unit>()
    private val pending = ConcurrentHashMap<String, CompletableFuture<JsonNode>>()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var process: Process? = null
    @Volatile private var startedByPlugin = false
    @Volatile private var log: (String) -> Unit = {}

    fun ensureConnected(logger: (String) -> Unit) {
        log = logger
        if (isConnected()) return

        synchronized(this) {
            if (isConnected()) return
            if (!tryConnect()) {
                startAgent()
                repeat(15) { index ->
                    if (tryConnect()) return
                    log("[Sidecar] Waiting for agent (${index + 1}/15)")
                    Thread.sleep(1000)
                }
            }
        }

        check(isConnected()) { "Unable to connect to Cross-IDE sidecar on port $PORT." }
    }

    fun isConnected(): Boolean = socket != null

    fun addMessageListener(listener: (JsonNode) -> Unit): Disposable {
        listeners.add(listener)
        return Disposable { listeners.remove(listener) }
    }

    fun callRpc(method: String, params: Map<String, Any?> = emptyMap()): JsonNode {
        val ws = socket ?: error("Sidecar is not connected.")
        val id = UUID.randomUUID().toString()
        val request = mapper.createObjectNode()
        request.put("jsonrpc", "2.0")
        request.put("method", method)
        request.put("id", id)
        request.putPOJO("params", params)

        val future = CompletableFuture<JsonNode>()
        pending[id] = future
        future.whenComplete { _, _ -> pending.remove(id) }
        scheduler.schedule({ future.completeExceptionally(IllegalStateException("Timed out waiting for $method")) }, 20, TimeUnit.SECONDS)
        ws.sendText(mapper.writeValueAsString(request), true)

        val response = future.get(22, TimeUnit.SECONDS)
        if (response.hasNonNull("error")) {
            error(response.path("error").path("message").asText("Sidecar RPC failed"))
        }
        return response.path("result")
    }

    fun sendMessage(message: JsonNode) {
        val ws = socket ?: error("Sidecar is not connected.")
        ws.sendText(mapper.writeValueAsString(message), true)
    }

    override fun dispose() {
        socket?.sendClose(WebSocket.NORMAL_CLOSURE, "shutdown")
        socket = null
        pending.values.forEach { it.completeExceptionally(IllegalStateException("Sidecar connection closed")) }
        pending.clear()
        if (startedByPlugin) {
            process?.destroyForcibly()
        }
        scheduler.shutdownNow()
    }

    private fun tryConnect(): Boolean = try {
        socket = client.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .buildAsync(URI.create("ws://127.0.0.1:$PORT"), Listener())
            .get(3, TimeUnit.SECONDS)
        log("[Sidecar] Connected to ws://127.0.0.1:$PORT")
        true
    } catch (_: Throwable) {
        false
    }

    private fun startAgent() {
        if (process?.isAlive == true) return

        val node = locateNodeExecutable() ?: error("Node.js executable was not found in PATH.")
        val bundle = locateAgentBundle() ?: error("Bundled core-agent was not found inside the plugin package.")
        log("[Sidecar] Starting agent: $node $bundle")

        process = ProcessBuilder(node.toString(), bundle.toString())
            .directory(bundle.parent.toFile())
            .redirectErrorStream(true)
            .apply { environment()["CROSSIDE_NO_BROWSER"] = "1" }
            .start()
        startedByPlugin = true

        AppExecutorUtil.getAppExecutorService().execute {
            process?.inputStream?.bufferedReader()?.useLines { lines ->
                lines.forEach { line ->
                    if (line.isNotBlank()) log("[Sidecar] $line")
                }
            }
        }
    }

    private fun locateAgentBundle(): Path? {
        val pluginPath = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath
        val userDir = Path.of(System.getProperty("user.dir"))
        val candidates = listOfNotNull(
            pluginPath?.resolve("lib")?.resolve("core-agent")?.resolve("bundle.js"),
            pluginPath?.resolve("core-agent")?.resolve("bundle.js"),
            userDir.resolveSibling("core-agent").resolve("bundle.js"),
            userDir.resolve("core-agent").resolve("bundle.js")
        )
        return candidates.firstOrNull { Files.exists(it) }
    }

    private fun locateNodeExecutable(): Path? {
        System.getenv("CROSSIDE_NODE_PATH")?.takeIf { it.isNotBlank() }?.let {
            val explicit = Path.of(it)
            if (Files.isExecutable(explicit)) return explicit
        }

        val names = if (System.getProperty("os.name").lowercase().contains("win")) {
            listOf("node.exe", "node.cmd", "node.bat")
        } else {
            listOf("node")
        }
        val pathEntries = System.getenv("PATH")?.split(File.pathSeparatorChar).orEmpty()
        for (entry in pathEntries) {
            for (name in names) {
                val candidate = Path.of(entry).resolve(name)
                if (Files.isRegularFile(candidate)) return candidate
            }
        }
        return null
    }

    private inner class Listener : WebSocket.Listener {
        private val buffer = StringBuilder()

        override fun onOpen(webSocket: WebSocket) {
            webSocket.request(1)
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
            buffer.append(data)
            if (last) {
                val payload = buffer.toString()
                buffer.setLength(0)
                handleMessage(payload)
            }
            webSocket.request(1)
            return CompletableFuture.completedFuture(null)
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*> {
            socket = null
            log("[Sidecar] Socket closed: $reason")
            return CompletableFuture.completedFuture(null)
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            socket = null
            log("[Sidecar] Socket error: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun handleMessage(payload: String) {
        val json = runCatching { mapper.readTree(payload) }.getOrNull() ?: return
        val id = json.path("id").asText()
        if (id.isNotBlank() && (json.has("result") || json.has("error"))) {
            pending.remove(id)?.complete(json)
            return
        }
        listeners.forEach { it(json) }
    }
}
