import Foundation
import GRDB
import Combine

/// The per-user local SQLite database (spec §2, §9). Everything the UI shows is read from here;
/// the network only feeds it through the sync engine.
final class AppDatabase {
    let pool: DatabasePool
    let userId: String

    init(userId: String, directory: URL? = nil) throws {
        self.userId = userId
        let dir = directory ?? AppDatabase.supportDirectory()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("homecast-\(userId).sqlite").path
        var config = Configuration()
        config.foreignKeysEnabled = true
        pool = try DatabasePool(path: path, configuration: config)
        try AppDatabase.migrator.migrate(pool)
    }

    /// In-memory database for tests and previews.
    init(inMemoryUserId userId: String) throws {
        self.userId = userId
        pool = try DatabasePool(path: NSTemporaryDirectory() + "hc-test-\(UUID().uuidString).sqlite")
        try AppDatabase.migrator.migrate(pool)
    }

    static func supportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Homecast", isDirectory: true)
    }

    static var migrator: DatabaseMigrator {
        var m = DatabaseMigrator()
        m.registerMigration("v1") { db in
            try db.create(table: "podcast") { t in
                t.primaryKey("id", .text)
                t.column("feedUrl", .text).notNull()
                t.column("isPrivate", .boolean).notNull().defaults(to: false)
                t.column("title", .text).notNull()
                t.column("author", .text).notNull().defaults(to: "")
                t.column("imageUrl", .text)
                t.column("description", .text).notNull().defaults(to: "")
                t.column("rev", .integer)
            }
            try db.create(table: "episode") { t in
                t.primaryKey("id", .text)
                t.column("podcastId", .text).notNull().indexed()
                t.column("guid", .text).notNull()
                t.column("title", .text).notNull()
                t.column("description", .text).notNull().defaults(to: "")
                t.column("audioUrl", .text).notNull()
                t.column("mimeType", .text).notNull().defaults(to: "audio/mpeg")
                t.column("durationSec", .double).notNull().defaults(to: 0)
                t.column("releasedAt", .integer).notNull().indexed()
                t.column("hasPublisherTranscript", .boolean)
                t.column("rev", .integer)
            }
            try db.create(table: "subscription") { t in
                t.primaryKey("id", .text)
                t.column("podcastId", .text).notNull().indexed()
                t.column("autoDownload", .blob).notNull()
                t.column("newEpisodeNotify", .boolean).notNull().defaults(to: true)
                t.column("clientUpdatedAt", .integer).notNull().defaults(to: 0)
                t.column("deleted", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "episodeState") { t in
                t.primaryKey("id", .text)
                t.column("episodeId", .text).notNull().indexed()
                t.column("status", .text).notNull()
                t.column("positionMs", .integer).notNull().defaults(to: 0)
                t.column("positionUpdatedAt", .integer)
                t.column("playedAt", .integer)
                t.column("starred", .boolean).notNull().defaults(to: false)
                t.column("clientUpdatedAt", .integer).notNull().defaults(to: 0)
                t.column("deleted", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "bookmark") { t in
                t.primaryKey("id", .text)
                t.column("episodeId", .text).notNull().indexed()
                t.column("positionMs", .integer).notNull()
                t.column("title", .text)
                t.column("note", .text)
                t.column("createdAt", .integer).notNull()
                t.column("clientUpdatedAt", .integer).notNull().defaults(to: 0)
                t.column("deleted", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "playlist") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("episodeIds", .blob).notNull()
                t.column("clientUpdatedAt", .integer).notNull().defaults(to: 0)
                t.column("deleted", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "smartPlaylist") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("definition", .blob).notNull()
                t.column("clientUpdatedAt", .integer).notNull().defaults(to: 0)
                t.column("deleted", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "settings") { t in
                t.primaryKey("id", .text)
                t.column("defaultSpeed", .double).notNull().defaults(to: 1)
                t.column("podcastSpeeds", .blob).notNull()
                t.column("prefs", .blob).notNull()
                t.column("clientUpdatedAt", .integer).notNull().defaults(to: 0)
                t.column("deleted", .boolean).notNull().defaults(to: false)
            }
            try db.create(table: "transcript") { t in
                t.primaryKey("episodeId", .text)
                t.column("source", .text).notNull()
                t.column("model", .text)
                t.column("segments", .blob).notNull()
            }
            try db.create(table: "download") { t in
                t.primaryKey("episodeId", .text)
                t.column("podcastId", .text).notNull().indexed()
                t.column("bytes", .integer).notNull()
                t.column("at", .integer).notNull()
                t.column("fileName", .text).notNull()
            }
            // Writes made locally wait here until the server acknowledges them (spec §3.5 "local outbox").
            try db.create(table: "outbox") { t in
                t.column("collection", .text).notNull()
                t.column("recordId", .text).notNull()
                t.primaryKey(["collection", "recordId"])
            }
            try db.create(table: "kv") { t in
                t.primaryKey("key", .text)
                t.column("value", .text).notNull()
            }
        }
        return m
    }

    // MARK: key/value

    func kv(_ key: String) -> String? {
        try? pool.read { try KVRow.fetchOne($0, key: key)?.value }
    }
    func setKV(_ key: String, _ value: String?) {
        try? pool.write { db in
            if let value { try KVRow(key: key, value: value).save(db) } else { _ = try KVRow.deleteOne(db, key: key) }
        }
    }
    func kvInt(_ key: String) -> Int { kv(key).flatMap(Int.init) ?? 0 }
    func kvJSON<T: Decodable>(_ key: String, as: T.Type = T.self) -> T? {
        kv(key).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
    func setKVJSON<T: Encodable>(_ key: String, _ value: T?) {
        guard let value, let data = try? JSONEncoder().encode(value) else { setKV(key, nil); return }
        setKV(key, String(data: data, encoding: .utf8))
    }
}

// MARK: - Joined view models

/// An episode together with everything lists need: its podcast, the user's state, and download status.
struct EpisodeItem: Identifiable, Hashable {
    let episode: Episode
    let podcast: Podcast?
    let state: EpisodeState?
    let downloaded: Bool

    var id: String { episode.id }
    var status: PlayStatus { state?.status ?? .unplayed }
    var starred: Bool { state?.starred ?? false }
    var positionMs: Int { state?.positionMs ?? 0 }
    /// 0...1 of the episode already heard.
    var progress: Double {
        guard episode.durationSec > 0 else { return 0 }
        if status == .played { return 1 }
        return min(1, Double(positionMs) / (episode.durationSec * 1000))
    }
    var remainingSec: Double { max(0, episode.durationSec - Double(positionMs) / 1000) }
}

extension Database {
    /// Resolve episodes to display items with three batched queries (podcast, state, download).
    func episodeItems(_ episodes: [Episode]) throws -> [EpisodeItem] {
        guard !episodes.isEmpty else { return [] }
        let podcastIds = Set(episodes.map(\.podcastId))
        let ids = episodes.map(\.id)
        let podcasts = Dictionary(uniqueKeysWithValues: try Podcast.filter(keys: podcastIds).fetchAll(self).map { ($0.id, $0) })
        var states: [String: EpisodeState] = [:]
        var downloaded = Set<String>()
        for chunk in stride(from: 0, to: ids.count, by: 500).map({ Array(ids[$0 ..< min($0 + 500, ids.count)]) }) {
            for s in try EpisodeState.filter(chunk.contains(Column("episodeId"))).filter(Column("deleted") == false).fetchAll(self) { states[s.episodeId] = s }
            for d in try Download.filter(keys: chunk).fetchAll(self) { downloaded.insert(d.episodeId) }
        }
        return episodes.map { EpisodeItem(episode: $0, podcast: podcasts[$0.podcastId], state: states[$0.id], downloaded: downloaded.contains($0.id)) }
    }

    /// Episodes by id, preserving the requested order (queues and playlists).
    func orderedEpisodeItems(ids: [String]) throws -> [EpisodeItem] {
        guard !ids.isEmpty else { return [] }
        let eps = Dictionary(uniqueKeysWithValues: try Episode.filter(keys: ids).fetchAll(self).map { ($0.id, $0) })
        return try episodeItems(ids.compactMap { eps[$0] })
    }

    func subscribedPodcastIds() throws -> Set<String> {
        Set(try Subscription.filter(Column("deleted") == false).fetchAll(self).map(\.podcastId))
    }

    func settings(userId: String) throws -> UserSettings {
        try UserSettings.fetchOne(self, key: RecordID.settings(userId: userId)).flatMap { $0.deleted ? nil : $0 } ?? UserSettings(id: RecordID.settings(userId: userId))
    }

    /// Smart-playlist input: every episode of subscribed podcasts as a rule-evaluation view.
    func episodeViews() throws -> [EpisodeView] {
        let subs = try subscribedPodcastIds()
        guard !subs.isEmpty else { return [] }
        let eps = try Episode.filter(subs.contains(Column("podcastId"))).fetchAll(self)
        let states = Dictionary(uniqueKeysWithValues: try EpisodeState.filter(Column("deleted") == false).fetchAll(self).map { ($0.episodeId, $0) })
        let downloaded = Set(try Download.fetchAll(self).map(\.episodeId))
        return eps.map { EpisodeView(id: $0.id, podcastId: $0.podcastId, title: $0.title, releasedAt: $0.releasedAt, durationSec: $0.durationSec, status: states[$0.id]?.status ?? .unplayed, downloaded: downloaded.contains($0.id), starred: states[$0.id]?.starred ?? false) }
    }
}

// MARK: - Live queries for SwiftUI

/// Observes a database query and republishes it whenever the underlying tables change.
@MainActor
final class Live<Value>: ObservableObject {
    @Published private(set) var value: Value
    private var task: Task<Void, Never>?

    init(_ initial: Value, in db: AppDatabase?, _ fetch: @escaping @Sendable (Database) throws -> Value) where Value: Sendable {
        value = initial
        guard let db else { return }
        // Seed synchronously so the first frame has data (no empty-state flash).
        if let first = try? db.pool.read(fetch) { value = first }
        task = Task { [weak self] in
            let observation = ValueObservation.tracking(fetch)
            do {
                for try await v in observation.values(in: db.pool) {
                    self?.value = v
                }
            } catch {}
        }
    }
    deinit { task?.cancel() }
}
