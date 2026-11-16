package app.homecast.android

import android.content.ComponentName
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import app.homecast.contract.AuthState
import app.homecast.contract.HomecastGraph
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.launch

/** Debug-only: `--ez browse true` makes the app act like Android Auto's media browser and log the tree (tag HC_AUTO). */
object DebugHook {
    fun run(activity: ComponentActivity, graph: HomecastGraph) {
        if (!activity.intent.hasExtra("browse")) return
        activity.lifecycleScope.launch {
            graph.session.state.first { it is AuthState.SignedIn }
            delay(8000)
            runCatching { dump(activity) }.onFailure { Log.e("HC_AUTO", "browse failed", it) }
        }
    }

    private suspend fun dump(context: android.content.Context) {
        val token = SessionToken(context, ComponentName(context.packageName, "app.homecast.playback.PlaybackService"))
        val browser = MediaBrowser.Builder(context, token).buildAsync().await()
        val root = browser.getLibraryRoot(null).await()
        Log.i("HC_AUTO", "root = ${root.value?.mediaId} '${root.value?.mediaMetadata?.title}'")
        suspend fun walk(id: String, depth: Int, indent: String) {
            val res = browser.getChildren(id, 0, 6, null).await()
            val items: List<MediaItem> = res.value ?: run { Log.i("HC_AUTO", "$indent<no children for $id: code ${res.resultCode}>"); return }
            items.forEach {
                val m = it.mediaMetadata
                Log.i("HC_AUTO", "$indent[${if (m.isBrowsable == true) "folder" else "play"}] ${it.mediaId} | ${m.title} | ${m.subtitle ?: m.artist ?: ""} | art=${m.artworkUri != null}")
                if (m.isBrowsable == true && depth > 0) walk(it.mediaId, depth - 1, "$indent    ")
            }
        }
        walk(root.value!!.mediaId, 2, "  ")
        browser.release()
    }
}
