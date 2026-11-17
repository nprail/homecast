package app.homecast.android.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.*
import app.homecast.android.MainActivity
import app.homecast.contract.AuthState
import app.homecast.contract.GraphProvider
import app.homecast.contract.HomecastGraph
import app.homecast.contract.PlayStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import java.util.concurrent.TimeUnit

/** Carries a tapped notification to the UI (the episode to open). */
object PendingOpen {
    val episodeId = MutableStateFlow<String?>(null)
    const val EXTRA = "openEpisodeId"
}

/**
 * New-episode notifications. A self-hosted server has no push service, so the app asks for new episodes itself: a
 * periodic background job syncs, and anything released since the last check in a podcast whose bell is on becomes a
 * notification. Android decides the exact timing (about hourly, less often in battery saver), so a notification can
 * arrive some time after the episode is published.
 */
object NewEpisodes {
    private const val PREFS = "homecast.notify"
    private const val WORK = "new-episodes"
    private const val CHANNEL = "new-episodes"
    private const val KEY_SINCE = "notify.since"
    private const val KEY_SEEN = "notify.seen"
    private const val MAX_SEEN = 400

    fun enabled(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

    fun canPost(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    /** Switch on and start tracking from now, so old episodes don't flood in. */
    suspend fun enable(context: Context, graph: HomecastGraph) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", true).apply()
        runCatching { graph.library.kvSet(KEY_SINCE, System.currentTimeMillis().toString()) }
        schedule(context)
    }

    fun disable(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", false).apply()
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
    }

    /** Keep the periodic job registered (call at start-up; it is a no-op when already scheduled). */
    fun schedule(context: Context) {
        if (!enabled(context)) return
        val req = PeriodicWorkRequestBuilder<NewEpisodesWorker>(1, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /**
     * Look for episodes released since the last check in podcasts with the bell on. With `notify = false` they are only
     * marked as seen (used when the app is open: you don't need a banner for what is on screen).
     */
    suspend fun check(context: Context, graph: HomecastGraph, notify: Boolean) {
        if (!enabled(context)) return
        val lib = graph.library
        val now = System.currentTimeMillis()
        val since = lib.kvGet(KEY_SINCE)?.toLongOrNull() ?: run { lib.kvSet(KEY_SINCE, now.toString()); return }
        val seen = runCatching { JSONArray(lib.kvGet(KEY_SEEN) ?: "[]").let { a -> (0 until a.length()).map { a.getString(it) } } }.getOrDefault(emptyList())
        val seenSet = seen.toSet()
        val bellOn = lib.subscribedPodcasts().first().filter { p -> lib.subscription(p.id).first()?.newEpisodeNotify == true }.map { it.id }.toSet()
        if (bellOn.isEmpty()) return
        val fresh = lib.latestEpisodes(100).first().filter {
            it.episode.podcastId in bellOn && it.episode.releasedAt > since && it.episode.releasedAt < now + 86_400_000 &&
                it.status != PlayStatus.Played && it.id !in seenSet
        }
        if (fresh.isEmpty()) return
        lib.kvSet(KEY_SEEN, JSONArray((seen + fresh.map { it.id }).takeLast(MAX_SEEN)).toString())
        if (!notify || !canPost(context)) return
        ensureChannel(context)
        val nm = NotificationManagerCompat.from(context)
        fresh.groupBy { it.episode.podcastId }.forEach { (podcastId, items) ->
            val first = items.first()
            val body = if (items.size == 1) first.episode.title else "${items.size} new episodes: " + items.take(2).joinToString(", ") { it.episode.title } + if (items.size > 2) "…" else ""
            val open = PendingIntent.getActivity(
                context, podcastId.hashCode(),
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra(PendingOpen.EXTRA, first.id),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val n = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_more)
                .setContentTitle(first.podcast?.title ?: "New episode")
                .setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(open).setAutoCancel(true).setGroup(podcastId)
                .build()
            @Suppress("MissingPermission") nm.notify(podcastId.hashCode(), n) // canPost() checked above
        }
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(NotificationChannel(CHANNEL, "New episodes", NotificationManager.IMPORTANCE_DEFAULT))
    }
}

internal class NewEpisodesWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as GraphProvider).graph
        if (graph.session.state.first { it !is AuthState.Launching } !is AuthState.SignedIn) return Result.success()
        return try {
            graph.sync.sync()
            NewEpisodes.check(applicationContext, graph, notify = true)
            Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) { Result.retry() }
    }
}
