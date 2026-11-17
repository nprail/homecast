package app.homecast.android.ui.share

import android.content.Context
import android.content.Intent
import app.homecast.android.ui.components.Fmt

/** A shareable "moment": a link that opens an episode in this server's web player, at a time if one is given. */
object Moment {
    fun url(serverUrl: String, episodeId: String, positionMs: Long? = null): String {
        val t = if ((positionMs ?: 0) >= 1000) "?t=${positionMs!! / 1000}" else ""
        return "${serverUrl.trim().trimEnd('/')}/episode/$episodeId$t"
    }

    /** A quote if there is one, then where it is from, then the link. */
    fun message(serverUrl: String, episodeId: String, title: String, podcast: String?, positionMs: Long? = null, quote: String? = null): String {
        val at = if ((positionMs ?: 0) >= 1000) " (${Fmt.clock(positionMs!!)})" else ""
        val from = title + (podcast?.let { ", $it" } ?: "") + at
        val q = quote?.trim()?.takeIf { it.isNotEmpty() }?.take(280)
        return (if (q != null) "“$q” — $from" else from) + "\n" + url(serverUrl, episodeId, positionMs)
    }
}

/** Open the system share sheet for an episode, optionally at a moment and with a quoted transcript line. */
fun Context.shareMoment(serverUrl: String, episodeId: String, title: String, podcast: String?, positionMs: Long? = null, quote: String? = null) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, title)
        putExtra(Intent.EXTRA_TEXT, Moment.message(serverUrl, episodeId, title, podcast, positionMs, quote))
    }
    startActivity(Intent.createChooser(send, if (positionMs != null && positionMs >= 1000) "Share this moment" else "Share episode"))
}
