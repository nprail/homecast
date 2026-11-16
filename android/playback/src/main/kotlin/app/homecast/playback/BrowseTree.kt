package app.homecast.playback

import android.app.Application
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaLibraryService.LibraryParams
import app.homecast.contract.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Android Auto browse tree (SPEC §3.12): Up Next / Playlists (manual + smart) / Podcasts / Downloads, shallow
 * lists, no text entry. Reads exclusively from the local [Library], so it works offline. Resolves the library
 * lazily on each call: while signed out (or before the user database exists) the tree is a single sign-in hint.
 */
internal class BrowseTree(private val app: Application, private val graphProvider: GraphProvider) {

    data class Listing(val items: List<MediaItem>, val contexts: Map<String, PlayContext>)

    private companion object {
        // Android Auto content-style constants (androidx.media.utils.MediaConstants), inlined to avoid the dependency.
        const val STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
        const val STYLE_BROWSABLE = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"
        const val STYLE_PLAYABLE = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
        const val STYLE_LIST = 1
        const val STYLE_GRID = 2
        const val EXTRA_PLAYBACK_STATUS = "android.media.extra.PLAYBACK_STATUS"
        const val EXTRA_COMPLETION = "androidx.media.MediaItem.Extras.COMPLETION_PERCENTAGE"
        const val MAX_LIST_IDS = 500
    }

    fun library(): Library? = runCatching { graphProvider.graph.library }.getOrNull()

    private suspend fun <T> Flow<T>.firstOrNull5s(): T? = withTimeoutOrNull(5_000) { first() }

    // ---- items -----------------------------------------------------------------------------------------------

    private fun styleExtras(browsable: Int? = null, playable: Int? = null) = Bundle().apply {
        browsable?.let { putInt(STYLE_BROWSABLE, it) }
        playable?.let { putInt(STYLE_PLAYABLE, it) }
    }

    private fun resUri(name: String): Uri = Uri.parse("android.resource://${app.packageName}/drawable/$name")

    private fun folder(id: String, title: String, subtitle: String?, mediaType: Int, art: Uri?, extras: Bundle): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder().setTitle(title).setSubtitle(subtitle).setArtist(subtitle).setArtworkUri(art)
                    .setIsBrowsable(true).setIsPlayable(false).setMediaType(mediaType).setExtras(extras).build()
            ).build()

    fun rootItem(): MediaItem = folder(BrowseIds.ROOT, "Homecast", null, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, null, styleExtras())

    fun rootParams(): LibraryParams = LibraryParams.Builder()
        .setExtras(Bundle().apply {
            putBoolean(STYLE_SUPPORTED, true)
            putInt(STYLE_BROWSABLE, STYLE_LIST)
            putInt(STYLE_PLAYABLE, STYLE_LIST)
        }).build()

    private fun tab(id: String): MediaItem = when (id) {
        BrowseIds.UP_NEXT -> folder(id, "Up Next", null, MediaMetadata.MEDIA_TYPE_PLAYLIST, resUri("ic_auto_up_next"), styleExtras(playable = STYLE_LIST))
        BrowseIds.PLAYLISTS -> folder(id, "Playlists", null, MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, resUri("ic_auto_playlists"), styleExtras(browsable = STYLE_LIST))
        BrowseIds.PODCASTS -> folder(id, "Podcasts", null, MediaMetadata.MEDIA_TYPE_FOLDER_PODCASTS, resUri("ic_auto_podcasts"), styleExtras(browsable = STYLE_GRID))
        else -> folder(BrowseIds.DOWNLOADS, "Downloads", null, MediaMetadata.MEDIA_TYPE_PLAYLIST, resUri("ic_auto_downloads"), styleExtras(playable = STYLE_LIST))
    }

    private fun signInItem(): MediaItem = MediaItem.Builder().setMediaId(BrowseIds.SIGN_IN).setMediaMetadata(
        MediaMetadata.Builder().setTitle("Open Homecast to sign in").setIsBrowsable(false).setIsPlayable(false).build()
    ).build()

    private fun infoItem(id: String, text: String): MediaItem = MediaItem.Builder().setMediaId(id).setMediaMetadata(
        MediaMetadata.Builder().setTitle(text).setIsBrowsable(false).setIsPlayable(false).build()
    ).build()

    fun episodeItem(item: EpisodeItem): MediaItem {
        val e = item.episode
        val status = BrowseShape.completionStatus(item.status, item.progress)
        val extras = Bundle().apply {
            putInt(EXTRA_PLAYBACK_STATUS, status)
            if (status == 1) putDouble(EXTRA_COMPLETION, item.progress.toDouble())
            putBoolean("homecast.downloaded", item.downloaded)
        }
        val podcastTitle = item.podcast?.title
        val md = MediaMetadata.Builder()
            .setTitle(e.title)
            .setSubtitle(BrowseShape.episodeSubtitle(podcastTitle, item.status, e.durationSec, item.remainingSec))
            .setArtist(podcastTitle)
            .setAlbumTitle(podcastTitle)
            .setArtworkUri(item.podcast?.imageUrl?.let { runCatching { Uri.parse(it) }.getOrNull() })
            .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setExtras(extras)
            .apply { if (e.durationSec > 0) setDurationMs((e.durationSec * 1000).toLong()) }
            .build()
        return MediaItem.Builder().setMediaId(e.id).setMediaMetadata(md).build()
    }

    private fun podcastItem(p: Podcast, unplayed: Int?): MediaItem = folder(
        BrowseIds.podcast(p.id), p.title,
        if (unplayed != null && unplayed > 0) "$unplayed unplayed" else p.author.ifBlank { null },
        MediaMetadata.MEDIA_TYPE_PODCAST, p.imageUrl?.let { runCatching { Uri.parse(it) }.getOrNull() }, styleExtras(playable = STYLE_LIST),
    )

    // ---- listings ----------------------------------------------------------------------------------------------

    private class EpisodeList(val label: String, val items: List<EpisodeItem>)

    private suspend fun episodeList(lib: Library, node: BrowseIds.Node): EpisodeList? = when (node) {
        BrowseIds.Node.UpNext -> EpisodeList("Up Next", lib.queue().firstOrNull5s() ?: emptyList())
        BrowseIds.Node.Downloads -> EpisodeList("Downloads", lib.downloads().firstOrNull5s() ?: emptyList())
        is BrowseIds.Node.Playlist -> lib.playlist(node.id).firstOrNull5s()?.let { EpisodeList(it.playlist.name, it.items) }
        is BrowseIds.Node.Smart -> lib.smartPlaylist(node.id).firstOrNull5s()?.let { EpisodeList(it.definition.name, it.items) }
        is BrowseIds.Node.Podcast -> {
            val title = lib.podcast(node.id).firstOrNull5s()?.title ?: "Podcast"
            val eps = lib.episodesForPodcast(node.id).firstOrNull5s() ?: emptyList()
            EpisodeList(title, BrowseShape.unplayedFirst(eps.take(60)) { it.status == PlayStatus.Played })
        }
        else -> null
    }

    suspend fun children(parentId: String, page: Int, pageSize: Int): Listing? {
        val node = BrowseIds.parse(parentId)
        if (node == BrowseIds.Node.Root) {
            if (library() == null) return Listing(listOf(signInItem()), emptyMap())
            return Listing(BrowseIds.rootTabs.map(::tab), emptyMap())
        }
        val lib = library() ?: return Listing(listOf(signInItem()), emptyMap())
        return when (node) {
            BrowseIds.Node.Playlists -> {
                val manual = lib.playlists().firstOrNull5s() ?: emptyList()
                val smart = runCatching { lib.smartPlaylistsSnapshot() }.getOrDefault(emptyList())
                val items = manual.map {
                    folder(BrowseIds.playlist(it.id), it.name, "${it.episodeIds.size} episodes", MediaMetadata.MEDIA_TYPE_PLAYLIST, resUri("ic_auto_playlists"), styleExtras(playable = STYLE_LIST))
                } + smart.map {
                    folder(BrowseIds.smart(it.id), it.definition.name, "Smart playlist · ${it.matchCount} episodes", MediaMetadata.MEDIA_TYPE_PLAYLIST, resUri("ic_auto_playlists"), styleExtras(playable = STYLE_LIST))
                }
                Listing(BrowseShape.page(items, page, pageSize).ifEmpty { if (page == 0) listOf(infoItem("empty:playlists", "No playlists yet. Create them in Homecast.")) else emptyList() }, emptyMap())
            }
            BrowseIds.Node.Podcasts -> {
                val pods = (lib.subscribedPodcasts().firstOrNull5s() ?: emptyList()).sortedBy { it.title.lowercase() }
                val counts = lib.unplayedCounts().firstOrNull5s() ?: emptyMap()
                val items = pods.map { podcastItem(it, counts[it.id]) }
                Listing(BrowseShape.page(items, page, pageSize).ifEmpty { if (page == 0) listOf(infoItem("empty:podcasts", "No podcasts yet. Add some in Homecast.")) else emptyList() }, emptyMap())
            }
            BrowseIds.Node.SignIn, is BrowseIds.Node.Episode, BrowseIds.Node.Root -> null
            else -> {
                val list = episodeList(lib, node) ?: return null
                val ids = list.items.map { it.id }.take(MAX_LIST_IDS)
                val shown = BrowseShape.page(list.items, page, pageSize)
                val ctx = PlayContext(list.label, ids)
                val items = shown.map(::episodeItem).ifEmpty {
                    if (page == 0) listOf(infoItem("empty:${parentId}", emptyText(node))) else emptyList()
                }
                Listing(items, shown.associate { it.id to ctx })
            }
        }
    }

    private fun emptyText(node: BrowseIds.Node) = when (node) {
        BrowseIds.Node.UpNext -> "Nothing in Up Next. Add episodes in Homecast."
        BrowseIds.Node.Downloads -> "No downloads. Download episodes in Homecast to listen offline."
        else -> "No episodes"
    }

    suspend fun item(mediaId: String): MediaItem? {
        return when (val node = BrowseIds.parse(mediaId)) {
            BrowseIds.Node.Root -> rootItem()
            BrowseIds.Node.UpNext, BrowseIds.Node.Playlists, BrowseIds.Node.Podcasts, BrowseIds.Node.Downloads -> tab(mediaId)
            BrowseIds.Node.SignIn -> signInItem()
            is BrowseIds.Node.Episode -> library()?.getEpisodeItem(node.id)?.let(::episodeItem)
            is BrowseIds.Node.Podcast -> library()?.podcast(node.id)?.firstOrNull5s()?.let { podcastItem(it, null) }
            is BrowseIds.Node.Playlist -> library()?.playlist(node.id)?.firstOrNull5s()?.let {
                folder(mediaId, it.playlist.name, "${it.items.size} episodes", MediaMetadata.MEDIA_TYPE_PLAYLIST, null, styleExtras(playable = STYLE_LIST))
            }
            is BrowseIds.Node.Smart -> library()?.smartPlaylist(node.id)?.firstOrNull5s()?.let {
                folder(mediaId, it.definition.name, "Smart playlist", MediaMetadata.MEDIA_TYPE_PLAYLIST, null, styleExtras(playable = STYLE_LIST))
            }
        }
    }

    // ---- search / voice -------------------------------------------------------------------------------------------

    private suspend fun searchEpisodes(lib: Library, query: String): List<EpisodeItem> {
        val pool = LinkedHashMap<String, EpisodeItem>()
        (lib.downloads().firstOrNull5s() ?: emptyList()).forEach { pool[it.id] = it }
        (lib.latestEpisodes(500).firstOrNull5s() ?: emptyList()).forEach { pool.putIfAbsent(it.id, it) }
        return pool.values.filter { BrowseShape.matches(query, it.episode.title, it.podcast?.title) }
    }

    private suspend fun searchPodcasts(lib: Library, query: String): List<Podcast> =
        (lib.subscribedPodcasts().firstOrNull5s() ?: emptyList()).filter { BrowseShape.matches(query, it.title, it.author) }

    /** Podcasts first (browsable), then matching episodes. */
    suspend fun search(query: String): List<MediaItem> {
        val lib = library() ?: return emptyList()
        val counts = lib.unplayedCounts().firstOrNull5s() ?: emptyMap()
        val pods = searchPodcasts(lib, query).take(5).map { podcastItem(it, counts[it.id]) }
        val eps = searchEpisodes(lib, query).take(25).map(::episodeItem)
        return pods + eps
    }

    class Resolved(val items: List<MediaItem>, val contexts: Map<String, PlayContext>)

    /**
     * Turns what a controller asked to play into playable episode items: voice-search requests (no media id, a search
     * query), containers (a podcast, a playlist, Up Next...) and plain episode ids (kept as they are).
     */
    suspend fun resolveForPlayback(items: List<MediaItem>): Resolved {
        val out = ArrayList<MediaItem>()
        val contexts = HashMap<String, PlayContext>()
        val lib = library()
        for (mi in items) {
            val query = mi.requestMetadata.searchQuery
            if (mi.mediaId.isEmpty()) {
                if (lib == null) continue
                if (query != null) {
                    val r = resolveSearch(lib, query) ?: continue
                    r.first.forEach { out += episodeItem(it) }
                    r.first.firstOrNull()?.let { contexts[it.id] = PlayContext(r.second, r.first.map { e -> e.id }.take(MAX_LIST_IDS)) }
                }
                continue
            }
            when (val node = BrowseIds.parse(mi.mediaId)) {
                is BrowseIds.Node.Episode -> out += mi
                BrowseIds.Node.Root, BrowseIds.Node.SignIn, BrowseIds.Node.Playlists, BrowseIds.Node.Podcasts -> Unit
                else -> {
                    val list = lib?.let { episodeList(it, node) } ?: continue
                    list.items.forEach { out += episodeItem(it) }
                    list.items.firstOrNull()?.let { contexts[it.id] = PlayContext(list.label, list.items.map { e -> e.id }.take(MAX_LIST_IDS)) }
                }
            }
        }
        return Resolved(out, contexts)
    }

    /** Best match for a spoken query: a matching podcast's newest unplayed episode, else the best episode match; blank = Up Next. */
    private suspend fun resolveSearch(lib: Library, query: String): Pair<List<EpisodeItem>, String>? {
        if (query.isBlank()) {
            val q = lib.queue().firstOrNull5s() ?: emptyList()
            if (q.isNotEmpty()) return q to "Up Next"
            val cont = lib.continueListening(8).firstOrNull5s() ?: emptyList()
            return if (cont.isEmpty()) null else cont to "Continue Listening"
        }
        searchPodcasts(lib, query).firstOrNull()?.let { p ->
            val eps = BrowseShape.unplayedFirst((lib.episodesForPodcast(p.id).firstOrNull5s() ?: emptyList()).take(60)) { it.status == PlayStatus.Played }
            if (eps.isNotEmpty()) return eps to p.title
        }
        val eps = searchEpisodes(lib, query)
        return if (eps.isEmpty()) null else eps to "Search"
    }
}
