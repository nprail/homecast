import Foundation

// Smart-playlist rules (spec §3.7), evaluated on-device. A port of shared/src/smartPlaylist.ts that must
// produce identical ids in identical order for the shared test vectors (shared/vectors/smart-playlist.json).

enum SmartRule: Codable, Hashable {
    case podcast(op: SetOp, ids: [String])
    case status(PlayStatus)
    case releasedWithin(days: Double)
    case duration(op: CompareOp, minutes: Double)
    case downloaded(Bool)
    case starred(Bool)
    case title(contains: String)

    enum SetOp: String, Codable { case `in`, notIn }
    enum CompareOp: String, Codable { case lt, gt }
    private enum K: String, CodingKey { case field, op, value }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .field) {
        case "podcast": self = .podcast(op: try c.decode(SetOp.self, forKey: .op), ids: try c.decode([String].self, forKey: .value))
        case "status": self = .status(try c.decode(PlayStatus.self, forKey: .value))
        case "releasedWithin": self = .releasedWithin(days: try c.decode(Double.self, forKey: .value))
        case "duration": self = .duration(op: try c.decode(CompareOp.self, forKey: .op), minutes: try c.decode(Double.self, forKey: .value))
        case "downloaded": self = .downloaded(try c.decode(Bool.self, forKey: .value))
        case "starred": self = .starred(try c.decode(Bool.self, forKey: .value))
        case "title": self = .title(contains: try c.decode(String.self, forKey: .value))
        case let f: throw DecodingError.dataCorruptedError(forKey: .field, in: c, debugDescription: "Unknown rule field \(f)")
        }
    }

    func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: K.self)
        switch self {
        case .podcast(let op, let ids): try c.encode("podcast", forKey: .field); try c.encode(op, forKey: .op); try c.encode(ids, forKey: .value)
        case .status(let s): try c.encode("status", forKey: .field); try c.encode("is", forKey: .op); try c.encode(s, forKey: .value)
        case .releasedWithin(let d): try c.encode("releasedWithin", forKey: .field); try c.encode("days", forKey: .op); try c.encode(d, forKey: .value)
        case .duration(let op, let m): try c.encode("duration", forKey: .field); try c.encode(op, forKey: .op); try c.encode(m, forKey: .value)
        case .downloaded(let b): try c.encode("downloaded", forKey: .field); try c.encode("is", forKey: .op); try c.encode(b, forKey: .value)
        case .starred(let b): try c.encode("starred", forKey: .field); try c.encode("is", forKey: .op); try c.encode(b, forKey: .value)
        case .title(let t): try c.encode("title", forKey: .field); try c.encode("contains", forKey: .op); try c.encode(t, forKey: .value)
        }
    }
}

struct SmartPlaylistDefinition: Codable, Hashable {
    enum Match: String, Codable, CaseIterable { case all, any }
    struct Sort: Codable, Hashable {
        enum Field: String, Codable { case releasedAt, duration, title }
        enum Dir: String, Codable { case asc, desc }
        var field: Field
        var dir: Dir
    }
    var name: String
    var match: Match
    var rules: [SmartRule]
    var sort: Sort
    var limit: Int?
    var autoDownload: Bool?

    static func blank(name: String = "New smart playlist") -> SmartPlaylistDefinition {
        .init(name: name, match: .all, rules: [.status(.unplayed)], sort: .init(field: .releasedAt, dir: .desc), limit: 50, autoDownload: false)
    }
}

/// The local-database view of an episode that rules are evaluated against.
struct EpisodeView: Hashable {
    var id: String
    var podcastId: String
    var title: String
    var releasedAt: Int
    var durationSec: Double
    var status: PlayStatus
    var downloaded: Bool
    var starred: Bool
}

enum SmartEvaluator {
    static func matches(_ rule: SmartRule, _ ep: EpisodeView, now: Int) -> Bool {
        switch rule {
        case .podcast(let op, let ids): return op == .in ? ids.contains(ep.podcastId) : !ids.contains(ep.podcastId)
        case .status(let s): return ep.status == s
        case .releasedWithin(let days): return Double(ep.releasedAt) >= Double(now) - days * 86_400_000 && ep.releasedAt <= now
        case .duration(let op, let minutes):
            let m = ep.durationSec / 60
            return op == .lt ? m < minutes : m > minutes
        case .downloaded(let b): return ep.downloaded == b
        case .starred(let b): return ep.starred == b
        case .title(let t): return ep.title.lowercased().contains(t.lowercased())
        }
    }

    /// Returns episode ids in order. An empty rule list matches every episode. Ties break on id so every platform agrees.
    static func evaluate(_ def: SmartPlaylistDefinition, episodes: [EpisodeView], now: Int) -> [String] {
        var matched = episodes.filter { ep in
            if def.rules.isEmpty { return true }
            return def.match == .all ? def.rules.allSatisfy { matches($0, ep, now: now) } : def.rules.contains { matches($0, ep, now: now) }
        }
        let dir: Int = def.sort.dir == .asc ? 1 : -1
        matched.sort { a, b in
            var c = 0
            switch def.sort.field {
            case .title:
                switch a.title.compare(b.title, options: [.caseInsensitive, .diacriticInsensitive], range: nil, locale: Locale(identifier: "en")) {
                case .orderedAscending: c = -1
                case .orderedDescending: c = 1
                case .orderedSame: c = 0
                }
            case .duration: c = a.durationSec < b.durationSec ? -1 : a.durationSec > b.durationSec ? 1 : 0
            case .releasedAt: c = a.releasedAt < b.releasedAt ? -1 : a.releasedAt > b.releasedAt ? 1 : 0
            }
            if c != 0 { return c * dir < 0 }
            return a.id < b.id
        }
        let limited = def.limit.map { Array(matched.prefix($0)) } ?? matched
        return limited.map(\.id)
    }

    /// Speed resolution (spec §3.3): podcast override, then global default.
    static func resolveSpeed(defaultSpeed: Double, podcastSpeeds: [String: Double], podcastId: String) -> Double {
        podcastSpeeds[podcastId] ?? defaultSpeed
    }
}
