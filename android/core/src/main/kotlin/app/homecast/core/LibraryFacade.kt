package app.homecast.core

import app.homecast.contract.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.*

/**
 * `Library` that delegates to the signed-in user's database. Flows follow sign-in/sign-out (they emit nothing while
 * signed out); one-shot calls throw [IllegalStateException] when signed out.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LibraryFacade(private val session: Session, private val workspaces: Workspaces) : Library {
    private fun cur(): LibraryImpl {
        val u = (session.state.value as? AuthState.SignedIn)?.user ?: throw IllegalStateException("Not signed in")
        return workspaces.get(u.id).library
    }

    private fun <T> flow(f: LibraryImpl.() -> Flow<T>): Flow<T> =
        session.state.map { (it as? AuthState.SignedIn)?.user?.id }.distinctUntilChanged()
            .flatMapLatest { id -> if (id == null) emptyFlow() else workspaces.get(id).library.f() }

    override fun subscribedPodcasts() = flow { subscribedPodcasts() }
    override fun unplayedCounts() = flow { unplayedCounts() }
    override fun podcast(id: String) = flow { podcast(id) }
    override fun subscription(podcastId: String) = flow { subscription(podcastId) }
    override fun subscribedPodcastIds() = flow { subscribedPodcastIds() }
    override fun episodesForPodcast(podcastId: String) = flow { episodesForPodcast(podcastId) }
    override fun episode(id: String) = flow { episode(id) }
    override fun latestEpisodes(limit: Int) = flow { latestEpisodes(limit) }
    override fun starredEpisodes() = flow { starredEpisodes() }
    override fun starredCount() = flow { starredCount() }
    override fun continueListening(limit: Int) = flow { continueListening(limit) }
    override fun queue() = flow { queue() }
    override fun playlists() = flow { playlists() }
    override fun playlist(id: String) = flow { playlist(id) }
    override fun smartPlaylists() = flow { smartPlaylists() }
    override fun smartPlaylist(id: String) = flow { smartPlaylist(id) }
    override fun bookmarks() = flow { bookmarks() }
    override fun bookmarkCount() = flow { bookmarkCount() }
    override fun bookmarksForEpisode(episodeId: String) = flow { bookmarksForEpisode(episodeId) }
    override fun downloads() = flow { downloads() }
    override fun downloadedBytes() = flow { downloadedBytes() }
    override fun settings() = flow { settings() }

    override suspend fun getEpisodeItem(id: String) = cur().getEpisodeItem(id)
    override suspend fun getEpisodeItems(ids: List<String>) = cur().getEpisodeItems(ids)
    override suspend fun getState(episodeId: String) = cur().getState(episodeId)
    override suspend fun getSettings() = cur().getSettings()
    override suspend fun queueIds() = cur().queueIds()
    override suspend fun evaluate(definition: SmartPlaylistDefinition) = cur().evaluate(definition)
    override suspend fun allSubscriptions() = cur().allSubscriptions()
    override suspend fun smartPlaylistsSnapshot() = cur().smartPlaylistsSnapshot()
    override suspend fun episodesOf(podcastId: String) = cur().episodesOf(podcastId)
    override suspend fun transcript(episodeId: String) = cur().transcript(episodeId)
    override suspend fun saveTranscript(t: Transcript) = cur().saveTranscript(t)
    override suspend fun transcriptPreview(episodeId: String, atMs: Long) = cur().transcriptPreview(episodeId, atMs)

    override suspend fun markPlayed(episodeId: String) = cur().markPlayed(episodeId)
    override suspend fun markUnplayed(episodeId: String) = cur().markUnplayed(episodeId)
    override suspend fun setStarred(episodeId: String, starred: Boolean) = cur().setStarred(episodeId, starred)
    override suspend fun savePosition(episodeId: String, positionMs: Long, durationMs: Long) = cur().savePosition(episodeId, positionMs, durationMs)
    override suspend fun updateEpisodeDuration(episodeId: String, durationSec: Double) = cur().updateEpisodeDuration(episodeId, durationSec)

    override suspend fun setAutoDownload(podcastId: String, value: AutoDownload) = cur().setAutoDownload(podcastId, value)
    override suspend fun setNotifyNewEpisodes(podcastId: String, on: Boolean) = cur().setNotifyNewEpisodes(podcastId, on)
    override suspend fun unsubscribe(podcastId: String) = cur().unsubscribe(podcastId)
    override suspend fun ensureSubscriptionLocal(podcastId: String) = cur().ensureSubscriptionLocal(podcastId)
    override suspend fun setDefaultSpeed(speed: Double) = cur().setDefaultSpeed(speed)
    override suspend fun setPodcastSpeed(podcastId: String, speed: Double?) = cur().setPodcastSpeed(podcastId, speed)
    override suspend fun setCleanupDays(podcastId: String, days: Int?) = cur().setCleanupDays(podcastId, days)

    override suspend fun addBookmark(episodeId: String, positionMs: Long, title: String?, note: String?) = cur().addBookmark(episodeId, positionMs, title, note)
    override suspend fun updateBookmark(id: String, title: String?, note: String?) = cur().updateBookmark(id, title, note)
    override suspend fun deleteBookmark(id: String) = cur().deleteBookmark(id)

    override suspend fun createPlaylist(name: String, episodeIds: List<String>) = cur().createPlaylist(name, episodeIds)
    override suspend fun renamePlaylist(id: String, name: String) = cur().renamePlaylist(id, name)
    override suspend fun deletePlaylist(id: String) = cur().deletePlaylist(id)
    override suspend fun addToPlaylist(id: String, episodeId: String) = cur().addToPlaylist(id, episodeId)
    override suspend fun setPlaylistEpisodes(id: String, episodeIds: List<String>) = cur().setPlaylistEpisodes(id, episodeIds)
    override suspend fun setQueue(ids: List<String>) = cur().setQueue(ids)
    override suspend fun enqueue(episodeId: String, where: QueuePosition, currentId: String?) = cur().enqueue(episodeId, where, currentId)
    override suspend fun dequeue(episodeId: String) = cur().dequeue(episodeId)
    override suspend fun moveInQueue(from: Int, to: Int) = cur().moveInQueue(from, to)

    override suspend fun saveSmartPlaylist(id: String?, definition: SmartPlaylistDefinition) = cur().saveSmartPlaylist(id, definition)
    override suspend fun deleteSmartPlaylist(id: String) = cur().deleteSmartPlaylist(id)

    override suspend fun allDownloads() = cur().allDownloads()
    override suspend fun downloadRecord(episodeId: String) = cur().downloadRecord(episodeId)
    override suspend fun recordDownload(record: DownloadRecord) = cur().recordDownload(record)
    override suspend fun deleteDownloadRecord(episodeId: String) = cur().deleteDownloadRecord(episodeId)

    override suspend fun kvGet(key: String) = cur().kvGet(key)
    override suspend fun kvSet(key: String, value: String?) = cur().kvSet(key, value)
}
