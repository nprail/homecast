package app.homecast.core

import app.homecast.contract.Library
import app.homecast.core.net.ApiClient
import app.homecast.core.net.MemorySecretStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * `Remote.streamUrl` (episode hosting): the signed URL the server returns is resolved against the configured server, and every
 * failure mode (not hosted, HTTP error, unreachable, too slow) yields null so playback falls back to the podcast's own URL.
 */
class StreamUrlTest {
    private var listener: ServerSocket? = null
    @Volatile private var seenAuth: String? = null
    @Volatile private var seenPath: String? = null

    @After fun stop() { listener?.close() }

    /** A minimal one-response-per-connection HTTP server (the unit-test classpath has no JDK HttpServer). */
    private fun start(status: Int, body: String, hangMs: Long = 0): String {
        val ss = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        listener = ss
        thread(isDaemon = true) {
            while (!ss.isClosed) {
                val c = try { ss.accept() } catch (e: Exception) { return@thread }
                thread(isDaemon = true) { c.use { handle(it, status, body, hangMs) } }
            }
        }
        return "http://127.0.0.1:${ss.localPort}"
    }

    private fun handle(c: Socket, status: Int, body: String, hangMs: Long) {
        val reader = c.getInputStream().bufferedReader()
        val requestLine = reader.readLine() ?: return
        seenPath = requestLine.split(' ')[1].substringBefore('?')
        var line = reader.readLine()
        while (!line.isNullOrEmpty()) {
            if (line.startsWith("authorization:", ignoreCase = true)) seenAuth = line.substringAfter(':').trim()
            line = reader.readLine()
        }
        if (hangMs > 0) Thread.sleep(hangMs)
        val bytes = body.toByteArray()
        val out = c.getOutputStream()
        out.write("HTTP/1.1 $status X\r\ncontent-type: application/json\r\ncontent-length: ${bytes.size}\r\nconnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
    }

    private fun remote(base: String): RemoteImpl {
        val secrets = MemorySecretStore()
        secrets.set("accessToken", "tok")
        secrets.set("accessExpiry", (System.currentTimeMillis() + 3_600_000).toString())
        // The library is only used for transcripts; streamUrl never touches it.
        val library = Proxy.newProxyInstance(Library::class.java.classLoader, arrayOf(Library::class.java)) { _, _, _ -> throw UnsupportedOperationException() } as Library
        return RemoteImpl(ApiClient(secrets, base), library)
    }

    @Test fun resolvesTheSignedUrlAgainstTheServer() = runBlocking {
        val base = start(200, """{"url":"/api/v1/media/ep1?u=user&exp=123&sig=abc","expiresAt":123}""")
        val url = remote(base).streamUrl("ep1")
        assertEquals("$base/api/v1/media/ep1?u=user&exp=123&sig=abc", url)
        assertEquals("/api/v1/episodes/ep1/stream", seenPath)
        assertEquals("Bearer tok", seenAuth) // the request for the link is authenticated; the link itself is not
    }

    @Test fun notHostedMeansNoUrl() = runBlocking {
        assertNull(remote(start(200, """{"url":null,"expiresAt":null}""")).streamUrl("ep1"))
    }

    @Test fun serverErrorsMeanNoUrl() = runBlocking {
        assertNull(remote(start(404, """{"error":{"code":"not_found","message":"Episode not found"}}""")).streamUrl("ep1"))
    }

    @Test fun garbageMeansNoUrl() = runBlocking {
        assertNull(remote(start(200, "<html>proxy error</html>")).streamUrl("ep1"))
    }

    @Test fun unreachableServerMeansNoUrl() = runBlocking {
        assertNull(remote("http://127.0.0.1:1").streamUrl("ep1"))
    }

    @Test fun aSlowServerIsGivenUpOnQuickly() = runBlocking {
        val base = start(200, """{"url":"/x","expiresAt":1}""", hangMs = 7_000)
        val started = System.currentTimeMillis()
        assertNull(remote(base).streamUrl("ep1"))
        assertTrue("took ${System.currentTimeMillis() - started} ms", System.currentTimeMillis() - started < 6_000)
    }
}
