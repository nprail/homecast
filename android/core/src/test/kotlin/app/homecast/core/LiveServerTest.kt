package app.homecast.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.homecast.contract.*
import app.homecast.core.db.AppDb
import app.homecast.core.net.ApiClient
import app.homecast.core.net.MemorySecretStore
import app.homecast.core.sync.SyncCore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * End-to-end check against a real server. Skipped unless HOMECAST_E2E_SERVER is set, e.g.
 * `HOMECAST_E2E_SERVER=http://localhost:8080 HOMECAST_E2E_USER=demo HOMECAST_E2E_PASS=demo-password-123 ./gradlew :core:testDebugUnitTest`
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveServerTest {
    @Test fun signInSyncAndRemoteCalls() = runBlocking {
        val server = System.getenv("HOMECAST_E2E_SERVER")
        assumeTrue(server != null)
        val user = System.getenv("HOMECAST_E2E_USER") ?: "demo"
        val pass = System.getenv("HOMECAST_E2E_PASS") ?: "demo-password-123"
        val secrets = MemorySecretStore(); val plain = MemorySecretStore()
        val api = ApiClient(secrets)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = SessionImpl(api, plain, scope)
        withTimeout(5000) { while (session.state.value == AuthState.Launching) delay(10) }
        assertEquals(AuthState.SignedOut, session.state.value)
        try { session.signIn(server!!, user, "wrong-password-xx"); fail() } catch (e: ApiException) { assertEquals(401, e.status) }
        session.signIn(server!!, user, pass)
        val me = (session.state.value as AuthState.SignedIn).user
        assertEquals(user, me.username)

        val db = AppDb.inMemory(ApplicationProvider.getApplicationContext<Context>())
        val lib = LibraryImpl(db, me.id, { null })
        SyncCore(db) { body -> val r = api.postJsonRaw("/sync", body); if (!r.ok) throw api.errorOf(r); r.body }.run()
        val pods = lib.subscribedPodcasts().first()
        println("synced podcasts: ${pods.map { it.title }}")
        assertTrue(pods.isNotEmpty())
        val eps = lib.latestEpisodes(10).first()
        assertTrue(eps.isNotEmpty())

        // write path: star + position, push, verify the server accepted it (outbox drained, no rejection)
        val ep = eps.first().episode
        val before = lib.getState(ep.id).starred
        lib.setStarred(ep.id, !before)
        lib.setPodcastSpeed(ep.podcastId, 1.4)
        lib.addBookmark(ep.id, 1234, "e2e", null).let { lib.deleteBookmark(it.id) }
        val core = SyncCore(db) { body -> val r = api.postJsonRaw("/sync", body); if (!r.ok) throw api.errorOf(r); r.body }
        core.run()
        assertEquals(0, db.dao().outboxCount())
        lib.setStarred(ep.id, before); lib.setPodcastSpeed(ep.podcastId, null); core.run()
        assertEquals(0, db.dao().outboxCount())

        val remote = RemoteImpl(api, lib)
        println("discover: " + remote.discover(null, "az").size)
        assertTrue(remote.exportOpml().contains("<opml"))
        assertTrue(remote.exportData().contains("exportedAt"))
        assertTrue(remote.sessions().any { it.current })
        println("transcript: " + remote.loadTranscript(ep.id))

        // episode hosting: a signed URL when the server keeps a copy (set HOMECAST_E2E_HOSTED=1 to require it), playable without credentials
        val streamUrl = remote.streamUrl(ep.id)
        println("stream url: $streamUrl")
        if (System.getenv("HOMECAST_E2E_HOSTED") == "1") {
            assertNotNull(streamUrl)
            assertTrue(streamUrl!!.startsWith("$server/api/v1/media/${ep.id}?"))
            OkHttpClient().newCall(Request.Builder().url(streamUrl).header("Range", "bytes=0-99").build()).execute().use {
                assertEquals(206, it.code)
                assertEquals(100, it.body.bytes().size)
            }
        }

        // offline mapping + session loss
        api.baseUrl = "http://127.0.0.1:1"
        try { remote.discover(null, "az"); fail() } catch (e: OfflineException) {}
        api.baseUrl = server
        session.signOut()
        assertEquals(AuthState.SignedOut, session.state.value)
        db.close()
    }
}
