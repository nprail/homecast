import Foundation
import GRDB

/// All local writes go through here (mirrors web `LocalData`): each one stamps `clientUpdatedAt`, queues the row
/// in the outbox, and schedules a sync. Reads happen through `Live` queries straight against the database.
@MainActor
final class LocalData {
    let db: AppDatabase
    weak var sync: SyncEngine?
    var userId: String { db.userId }

    init(db: AppDatabase) { self.db = db }

    nonisolated static func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    private func queue<R: PersistableRecord & Identifiable>(_ d: Database, _ collection: String, _ r: R) throws where R.ID == String {
        try r.save(d)
        try OutboxEntry(collection: collection, recordId: r.id).save(d)
    }
    private func scheduleSync(_ after: Double = 2) { sync?.schedule(after: after) }

    // MARK: episode state

    func state(for episodeId: String) -> EpisodeState {
        let found = try? db.pool.read { try EpisodeState.filter(Column("episodeId") == episodeId).fetchOne($0) }
        return found ?? EpisodeState(id: RecordID.state(userId: userId, episodeId: episodeId), episodeId: episodeId)
    }

    func patchState(_ episodeId: String, positionUpdated: Bool = false, syncSoon: Bool = true, _ mutate: (inout EpisodeState) -> Void) {
        var s = state(for: episodeId)
        mutate(&s)
        let now = Self.nowMs()
        s.clientUpdatedAt = now
        s.deleted = false
        if positionUpdated { s.positionUpdatedAt = now }
        try? db.pool.write { try queue($0, "episodeStates", s) }
        if syncSoon { scheduleSync() }
    }

    func markPlayed(_ episodeId: String) {
        patchState(episodeId) { $0.status = .played; $0.playedAt = Self.nowMs() }
    }
    func markUnplayed(_ episodeId: String) {
        patchState(episodeId, positionUpdated: true) { $0.status = .unplayed; $0.positionMs = 0; $0.playedAt = nil }
    }
    func setStarred(_ episodeId: String, _ starred: Bool) {
        patchState(episodeId) { $0.starred = starred }
    }
    /// Position write from the player: local only; the player schedules syncs itself (spec §3.1).
    func savePosition(_ episodeId: String, positionMs: Int, durationMs: Int) {
        let nearEnd = durationMs > 0 && positionMs >= durationMs - 5000
        patchState(episodeId, positionUpdated: true, syncSoon: false) {
            $0.positionMs = positionMs
            $0.status = nearEnd ? .played : positionMs > 1000 ? .inProgress : .unplayed
            if nearEnd { $0.playedAt = Self.nowMs() }
        }
    }

    // MARK: subscriptions

    func subscription(for podcastId: String) -> Subscription? {
        (try? db.pool.read { try Subscription.filter(Column("podcastId") == podcastId).filter(Column("deleted") == false).fetchOne($0) }) ?? nil
    }
    func setNotify(_ podcastId: String, _ on: Bool) {
        guard var s = subscription(for: podcastId) else { return }
        s.newEpisodeNotify = on
        s.clientUpdatedAt = Self.nowMs()
        try? db.pool.write { try queue($0, "subscriptions", s) }
        scheduleSync()
    }
    func setAutoDownload(_ podcastId: String, _ value: AutoDownload) {
        guard var s = subscription(for: podcastId) else { return }
        s.autoDownload = value
        s.clientUpdatedAt = Self.nowMs()
        try? db.pool.write { try queue($0, "subscriptions", s) }
        scheduleSync()
    }
    func unsubscribe(_ podcastId: String) {
        guard var s = subscription(for: podcastId) else { return }
        s.deleted = true
        s.clientUpdatedAt = Self.nowMs()
        try? db.pool.write { try queue($0, "subscriptions", s) }
        scheduleSync(0.3)
    }
    /// After subscribing through the API (Discover), mirror the subscription locally so the UI updates at once.
    func ensureSubscriptionLocal(_ podcastId: String) {
        let existing = try? db.pool.read { try Subscription.filter(Column("podcastId") == podcastId).fetchOne($0) }
        if let e = existing, !e.deleted { return }
        let s = Subscription(id: existing?.id ?? RecordID.subscription(userId: userId, podcastId: podcastId), podcastId: podcastId, clientUpdatedAt: Self.nowMs())
        try? db.pool.write { try queue($0, "subscriptions", s) }
    }

    // MARK: settings (spec §3.3)

    func settings() -> UserSettings { (try? db.pool.read { try $0.settings(userId: userId) }) ?? UserSettings(id: RecordID.settings(userId: userId)) }
    func updateSettings(_ mutate: (inout UserSettings) -> Void) {
        var s = settings()
        mutate(&s)
        s.clientUpdatedAt = Self.nowMs()
        s.deleted = false
        try? db.pool.write { try queue($0, "settings", s) }
        scheduleSync()
    }
    func setDefaultSpeed(_ speed: Double) { updateSettings { $0.defaultSpeed = Self.roundSpeed(speed) } }
    /// `nil` clears the override.
    func setPodcastSpeed(_ podcastId: String, _ speed: Double?) {
        updateSettings { if let speed { $0.podcastSpeeds[podcastId] = Self.roundSpeed(speed) } else { $0.podcastSpeeds[podcastId] = nil } }
    }
    func setCleanupDays(_ podcastId: String, _ days: Int?) {
        updateSettings { var c = $0.cleanupDays; c[podcastId] = days; $0.cleanupDays = c }
    }
    nonisolated static func roundSpeed(_ s: Double) -> Double { (min(3, max(0.5, s)) * 10).rounded() / 10 }

    // MARK: bookmarks (spec §3.2)

    @discardableResult
    func addBookmark(episodeId: String, positionMs: Int, title: String?, note: String?) -> Bookmark {
        let now = Self.nowMs()
        let b = Bookmark(id: RecordID.new(), episodeId: episodeId, positionMs: positionMs, title: title?.trimmedOrNil, note: note?.trimmedOrNil, createdAt: now, clientUpdatedAt: now)
        try? db.pool.write { try queue($0, "bookmarks", b) }
        scheduleSync()
        return b
    }
    func updateBookmark(_ id: String, title: String?, note: String?) {
        guard var b = try? db.pool.read({ try Bookmark.fetchOne($0, key: id) }) else { return }
        b.title = title?.trimmedOrNil; b.note = note?.trimmedOrNil; b.clientUpdatedAt = Self.nowMs()
        try? db.pool.write { try queue($0, "bookmarks", b) }
        scheduleSync()
    }
    func deleteBookmark(_ id: String) {
        guard var b = try? db.pool.read({ try Bookmark.fetchOne($0, key: id) }) else { return }
        b.deleted = true; b.clientUpdatedAt = Self.nowMs()
        try? db.pool.write { try queue($0, "bookmarks", b) }
        scheduleSync()
    }

    // MARK: playlists (spec §3.6)

    @discardableResult
    func createPlaylist(name: String, episodeIds: [String] = []) -> String {
        let p = Playlist(id: RecordID.new(), name: name.trimmedOrNil ?? "Untitled", episodeIds: episodeIds, clientUpdatedAt: Self.nowMs())
        try? db.pool.write { try queue($0, "playlists", p) }
        scheduleSync()
        return p.id
    }
    func updatePlaylist(_ id: String, _ mutate: (inout Playlist) -> Void) {
        guard var p = try? db.pool.read({ try Playlist.fetchOne($0, key: id) }) else { return }
        mutate(&p)
        p.clientUpdatedAt = Self.nowMs()
        try? db.pool.write { try queue($0, "playlists", p) }
        scheduleSync()
    }
    func deletePlaylist(_ id: String) { updatePlaylist(id) { $0.deleted = true } }
    func addToPlaylist(_ id: String, episodeId: String) {
        updatePlaylist(id) { if !$0.episodeIds.contains(episodeId) { $0.episodeIds.append(episodeId) } }
    }

    // MARK: Up Next: the built-in playlist

    func queueIds() -> [String] {
        let q = try? db.pool.read { try Playlist.fetchOne($0, key: RecordID.upNext(userId: userId)) }
        if let q, !q.deleted { return q.episodeIds }
        return []
    }
    func setQueue(_ ids: [String]) {
        let id = RecordID.upNext(userId: userId)
        var seen = Set<String>()
        let unique = ids.filter { seen.insert($0).inserted }
        let p = Playlist(id: id, name: RecordID.upNextName, episodeIds: unique, clientUpdatedAt: Self.nowMs())
        try? db.pool.write { try queue($0, "playlists", p) }
        scheduleSync()
    }
    enum QueuePosition { case next, last, front }
    func enqueue(_ episodeId: String, _ where: QueuePosition, currentId: String? = nil) {
        var q = queueIds().filter { $0 != episodeId }
        switch `where` {
        case .front: q.insert(episodeId, at: 0)
        case .next: q.insert(episodeId, at: (q.first != nil && q.first == currentId) ? 1 : 0)
        case .last: q.append(episodeId)
        }
        setQueue(q)
    }
    func dequeue(_ episodeId: String) { setQueue(queueIds().filter { $0 != episodeId }) }
    func moveInQueue(from: IndexSet, to: Int) {
        var q = queueIds()
        q.move(fromOffsets: from, toOffset: to)
        setQueue(q)
    }

    // MARK: smart playlists (spec §3.7)

    @discardableResult
    func saveSmartPlaylist(id: String?, definition: SmartPlaylistDefinition) -> String {
        let rid = id ?? RecordID.new()
        let p = SmartPlaylist(id: rid, name: definition.name, definition: definition, clientUpdatedAt: Self.nowMs())
        try? db.pool.write { try queue($0, "smartPlaylists", p) }
        scheduleSync()
        return rid
    }
    func deleteSmartPlaylist(_ id: String) {
        guard var p = try? db.pool.read({ try SmartPlaylist.fetchOne($0, key: id) }) else { return }
        p.deleted = true; p.clientUpdatedAt = Self.nowMs()
        try? db.pool.write { try queue($0, "smartPlaylists", p) }
        scheduleSync()
    }

    /// Ordered episode ids for a smart playlist, evaluated on-device from local data.
    func evaluate(_ def: SmartPlaylistDefinition) -> [String] {
        let views = (try? db.pool.read { try $0.episodeViews() }) ?? []
        return SmartEvaluator.evaluate(def, episodes: views, now: Self.nowMs())
    }
}

extension String {
    var trimmedOrNil: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
