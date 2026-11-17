package app.homecast.android

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import android.content.Intent
import app.homecast.android.notify.NewEpisodes
import app.homecast.android.notify.PendingOpen
import app.homecast.android.ui.AppRoot
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.theme.HomecastTheme
import androidx.lifecycle.lifecycleScope
import app.homecast.android.BuildConfig
import app.homecast.contract.AuthState
import app.homecast.contract.GraphProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        val graph = (application as GraphProvider).graph
        intent.getStringExtra(PendingOpen.EXTRA)?.let { PendingOpen.episodeId.value = it }
        NewEpisodes.schedule(this)
        if (BuildConfig.DEBUG) {
            // Test hook: adb shell am start -n app.homecast.android/.MainActivity --es autologin "server,user,password"
            DebugHook.run(this, graph)
            intent.getStringExtra("autologin")?.split(",")?.takeIf { it.size == 3 }?.let { (server, user, pass) ->
                lifecycleScope.launch { if (graph.session.state.first { it !is AuthState.Launching } is AuthState.SignedOut) runCatching { graph.session.signIn(server, user, pass) } }
            }
        }
        setContent {
            HomecastTheme {
                CompositionLocalProvider(LocalGraph provides graph) { AppRoot() }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(PendingOpen.EXTRA)?.let { PendingOpen.episodeId.value = it }
    }

    override fun onStart() {
        super.onStart()
        // Whatever arrived while you were away is on screen now: record it as seen so it isn't announced later.
        val graph = (application as GraphProvider).graph
        lifecycleScope.launch {
            runCatching {
                if (graph.session.state.first { it !is AuthState.Launching } is AuthState.SignedIn) {
                    graph.sync.sync()
                    NewEpisodes.check(this@MainActivity, graph, notify = false)
                }
            }
        }
    }
}
