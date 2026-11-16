import Foundation
import GRDB

// Local-first records (spec §4, §5). Synced rows mirror the server's JSON field-for-field, so the same
// Codable types decode sync responses and persist to SQLite. A row is "dirty" while it has an outbox entry.

enum PlayStatus: String, Codable, DatabaseValueConvertible, Hashable, CaseIterable {
    case unplayed, inProgress, played
}

struct Podcast: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "podcast"
    var id: String
    var feedUrl: String
    var isPrivate: Bool
    var title: String
    var author: String
    var imageUrl: String?
    var summary: String
    var rev: Int?
    enum CodingKeys: String, CodingKey { case id, feedUrl, isPrivate, title, author, imageUrl, summary = "description", rev }
}

struct Episode: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "episode"
    var id: String
    var podcastId: String
    var guid: String
    var title: String
    var summary: String
    var audioUrl: String
    var mimeType: String
    var durationSec: Double
    var releasedAt: Int
    var hasPublisherTranscript: Bool?
    var rev: Int?
    enum CodingKeys: String, CodingKey {
        case id, podcastId, guid, title, summary = "description", audioUrl, mimeType, durationSec, releasedAt, hasPublisherTranscript, rev
    }
    var releasedDate: Date { Date(timeIntervalSince1970: Double(releasedAt) / 1000) }
}

struct AutoDownload: Codable, Hashable {
    enum Mode: String, Codable, CaseIterable { case off, latest, all }
    var mode: Mode = .off
    var count: Int?
}

struct Subscription: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "subscription"
    var id: String
    var podcastId: String
    var autoDownload: AutoDownload
    var newEpisodeNotify: Bool
    var clientUpdatedAt: Int
    var deleted: Bool = false
    enum CodingKeys: String, CodingKey { case id, podcastId, autoDownload, newEpisodeNotify, clientUpdatedAt, deleted }
    init(id: String, podcastId: String, autoDownload: AutoDownload = .init(), newEpisodeNotify: Bool = true, clientUpdatedAt: Int = 0, deleted: Bool = false) {
        self.id = id; self.podcastId = podcastId; self.autoDownload = autoDownload; self.newEpisodeNotify = newEpisodeNotify
        self.clientUpdatedAt = clientUpdatedAt; self.deleted = deleted
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        podcastId = try c.decode(String.self, forKey: .podcastId)
        autoDownload = try c.decodeIfPresent(AutoDownload.self, forKey: .autoDownload) ?? .init()
        newEpisodeNotify = try c.decodeIfPresent(Bool.self, forKey: .newEpisodeNotify) ?? true
        clientUpdatedAt = try c.decodeIfPresent(Int.self, forKey: .clientUpdatedAt) ?? 0
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }
}

struct EpisodeState: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "episodeState"
    var id: String
    var episodeId: String
    var status: PlayStatus
    var positionMs: Int
    var positionUpdatedAt: Int?
    var playedAt: Int?
    var starred: Bool
    var clientUpdatedAt: Int
    var deleted: Bool = false
    enum CodingKeys: String, CodingKey { case id, episodeId, status, positionMs, positionUpdatedAt, playedAt, starred, clientUpdatedAt, deleted }
    init(id: String, episodeId: String, status: PlayStatus = .unplayed, positionMs: Int = 0, positionUpdatedAt: Int? = nil, playedAt: Int? = nil, starred: Bool = false, clientUpdatedAt: Int = 0, deleted: Bool = false) {
        self.id = id; self.episodeId = episodeId; self.status = status; self.positionMs = positionMs; self.positionUpdatedAt = positionUpdatedAt
        self.playedAt = playedAt; self.starred = starred; self.clientUpdatedAt = clientUpdatedAt; self.deleted = deleted
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        episodeId = try c.decode(String.self, forKey: .episodeId)
        status = try c.decodeIfPresent(PlayStatus.self, forKey: .status) ?? .unplayed
        positionMs = try c.decodeIfPresent(Int.self, forKey: .positionMs) ?? 0
        positionUpdatedAt = try c.decodeIfPresent(Int.self, forKey: .positionUpdatedAt)
        playedAt = try c.decodeIfPresent(Int.self, forKey: .playedAt)
        starred = try c.decodeIfPresent(Bool.self, forKey: .starred) ?? false
        clientUpdatedAt = try c.decodeIfPresent(Int.self, forKey: .clientUpdatedAt) ?? 0
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }
}

struct Bookmark: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "bookmark"
    var id: String
    var episodeId: String
    var positionMs: Int
    var title: String?
    var note: String?
    var createdAt: Int
    var clientUpdatedAt: Int
    var deleted: Bool = false
    enum CodingKeys: String, CodingKey { case id, episodeId, positionMs, title, note, createdAt, clientUpdatedAt, deleted }
    init(id: String, episodeId: String, positionMs: Int, title: String? = nil, note: String? = nil, createdAt: Int, clientUpdatedAt: Int = 0, deleted: Bool = false) {
        self.id = id; self.episodeId = episodeId; self.positionMs = positionMs; self.title = title; self.note = note
        self.createdAt = createdAt; self.clientUpdatedAt = clientUpdatedAt; self.deleted = deleted
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        episodeId = try c.decode(String.self, forKey: .episodeId)
        positionMs = try c.decodeIfPresent(Int.self, forKey: .positionMs) ?? 0
        title = try c.decodeIfPresent(String.self, forKey: .title)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        clientUpdatedAt = try c.decodeIfPresent(Int.self, forKey: .clientUpdatedAt) ?? 0
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }
}

struct Playlist: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "playlist"
    var id: String
    var name: String
    var episodeIds: [String]
    var clientUpdatedAt: Int
    var deleted: Bool = false
    enum CodingKeys: String, CodingKey { case id, name, episodeIds, clientUpdatedAt, deleted }
    init(id: String, name: String, episodeIds: [String] = [], clientUpdatedAt: Int = 0, deleted: Bool = false) {
        self.id = id; self.name = name; self.episodeIds = episodeIds; self.clientUpdatedAt = clientUpdatedAt; self.deleted = deleted
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        episodeIds = try c.decodeIfPresent([String].self, forKey: .episodeIds) ?? []
        clientUpdatedAt = try c.decodeIfPresent(Int.self, forKey: .clientUpdatedAt) ?? 0
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }
}

struct SmartPlaylist: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "smartPlaylist"
    var id: String
    var name: String
    var definition: SmartPlaylistDefinition
    var clientUpdatedAt: Int
    var deleted: Bool = false
    enum CodingKeys: String, CodingKey { case id, name, definition, clientUpdatedAt, deleted }
    init(id: String, name: String, definition: SmartPlaylistDefinition, clientUpdatedAt: Int = 0, deleted: Bool = false) {
        self.id = id; self.name = name; self.definition = definition; self.clientUpdatedAt = clientUpdatedAt; self.deleted = deleted
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        definition = try c.decode(SmartPlaylistDefinition.self, forKey: .definition)
        clientUpdatedAt = try c.decodeIfPresent(Int.self, forKey: .clientUpdatedAt) ?? 0
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }
}

struct UserSettings: Codable, FetchableRecord, PersistableRecord, Identifiable, Hashable {
    static let databaseTableName = "settings"
    var id: String
    var defaultSpeed: Double
    var podcastSpeeds: [String: Double]
    var prefs: [String: JSONValue]
    var clientUpdatedAt: Int
    var deleted: Bool = false
    enum CodingKeys: String, CodingKey { case id, defaultSpeed, podcastSpeeds, prefs, clientUpdatedAt, deleted }
    init(id: String, defaultSpeed: Double = 1, podcastSpeeds: [String: Double] = [:], prefs: [String: JSONValue] = [:], clientUpdatedAt: Int = 0, deleted: Bool = false) {
        self.id = id; self.defaultSpeed = defaultSpeed; self.podcastSpeeds = podcastSpeeds; self.prefs = prefs
        self.clientUpdatedAt = clientUpdatedAt; self.deleted = deleted
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        defaultSpeed = try c.decodeIfPresent(Double.self, forKey: .defaultSpeed) ?? 1
        podcastSpeeds = try c.decodeIfPresent([String: Double].self, forKey: .podcastSpeeds) ?? [:]
        prefs = try c.decodeIfPresent([String: JSONValue].self, forKey: .prefs) ?? [:]
        clientUpdatedAt = try c.decodeIfPresent(Int.self, forKey: .clientUpdatedAt) ?? 0
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }

    /// "Delete played downloads after N days", per podcast (spec §3.5). Stored in synced `prefs`.
    var cleanupDays: [String: Int] {
        get {
            guard case .object(let o)? = prefs["cleanupDays"] else { return [:] }
            return o.compactMapValues { if case .number(let n) = $0 { return Int(n) } else { return nil } }
        }
        set {
            prefs["cleanupDays"] = .object(newValue.mapValues { .number(Double($0)) })
        }
    }
}

struct TranscriptSegment: Codable, Hashable, Identifiable {
    var startMs: Int
    var endMs: Int
    var text: String
    var id: Int { startMs }
}

struct Transcript: Codable, FetchableRecord, PersistableRecord, Hashable {
    static let databaseTableName = "transcript"
    var episodeId: String
    var source: String
    var model: String?
    var segments: [TranscriptSegment]
}

struct Download: Codable, FetchableRecord, PersistableRecord, Hashable {
    static let databaseTableName = "download"
    var episodeId: String
    var podcastId: String
    var bytes: Int
    var at: Int
    var fileName: String
}

struct OutboxEntry: Codable, FetchableRecord, PersistableRecord, Hashable {
    static let databaseTableName = "outbox"
    var collection: String
    var recordId: String
}

struct KVRow: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "kv"
    var key: String
    var value: String
}

// MARK: - Loose JSON (for synced `prefs`, which the server treats as opaque)

enum JSONValue: Codable, Hashable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to e: Encoder) throws {
        var c = e.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

// MARK: - Deterministic ids (one row per user+episode / user+podcast; every device derives the same id)

enum RecordID {
    private static func hex(_ uuid: String) -> String { uuid.replacingOccurrences(of: "-", with: "") }
    static func state(userId: String, episodeId: String) -> String { String((hex(userId) + hex(episodeId)).prefix(64)) }
    static func subscription(userId: String, podcastId: String) -> String { String((hex(userId) + hex(podcastId)).prefix(64)) }
    static func settings(userId: String) -> String { "s" + hex(userId) }
    static func upNext(userId: String) -> String { "q" + hex(userId) }
    static let upNextName = "__upnext__"
    static func new() -> String { UUID().uuidString.lowercased() }
}
