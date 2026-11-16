package app.homecast.core

import java.util.UUID

/** Deterministic record ids (one row per user+episode / user+podcast; every device derives the same id). */
object RecordID {
    private fun hex(uuid: String) = uuid.replace("-", "")
    fun state(userId: String, episodeId: String): String = (hex(userId) + hex(episodeId)).take(64)
    fun subscription(userId: String, podcastId: String): String = (hex(userId) + hex(podcastId)).take(64)
    fun settings(userId: String): String = "s" + hex(userId)
    fun upNext(userId: String): String = "q" + hex(userId)
    const val UP_NEXT_NAME = "__upnext__"
    fun new(): String = UUID.randomUUID().toString().lowercase()
}
