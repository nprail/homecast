import XCTest
import GRDB
@testable import Homecast

/// Runs the shared contract vectors (shared/vectors/smart-playlist.json): the Swift evaluator must return
/// the same ids in the same order as the TypeScript one (spec §9).
final class SmartPlaylistTests: XCTestCase {
    struct Vectors: Decodable {
        struct Ep: Decodable { var id: String; var podcastId: String; var title: String; var releasedAt: Int; var durationSec: Double; var status: PlayStatus; var downloaded: Bool; var starred: Bool }
        struct Case: Decodable { var name: String; var definition: SmartPlaylistDefinition; var expected: [String] }
        var now: Int
        var episodes: [Ep]
        var cases: [Case]
    }

    func testSharedVectors() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "smart-playlist", withExtension: "json"))
        let v = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        let views = v.episodes.map { EpisodeView(id: $0.id, podcastId: $0.podcastId, title: $0.title, releasedAt: $0.releasedAt, durationSec: $0.durationSec, status: $0.status, downloaded: $0.downloaded, starred: $0.starred) }
        XCTAssertGreaterThan(v.cases.count, 5)
        for c in v.cases {
            XCTAssertEqual(SmartEvaluator.evaluate(c.definition, episodes: views, now: v.now), c.expected, c.name)
        }
    }

    func testRuleRoundTripMatchesServerSchema() throws {
        let def = SmartPlaylistDefinition(name: "X", match: .any, rules: [.podcast(op: .notIn, ids: ["a"]), .status(.inProgress), .releasedWithin(days: 7), .duration(op: .gt, minutes: 20), .downloaded(true), .starred(false), .title(contains: "t")], sort: .init(field: .title, dir: .asc), limit: 5, autoDownload: true)
        let data = try JSONEncoder().encode(def)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rules = try XCTUnwrap(obj["rules"] as? [[String: Any]])
        XCTAssertEqual(rules[0]["field"] as? String, "podcast"); XCTAssertEqual(rules[0]["op"] as? String, "notIn")
        XCTAssertEqual(rules[1]["op"] as? String, "is"); XCTAssertEqual(rules[1]["value"] as? String, "inProgress")
        XCTAssertEqual(rules[2]["op"] as? String, "days"); XCTAssertEqual(rules[6]["op"] as? String, "contains")
        XCTAssertEqual(try JSONDecoder().decode(SmartPlaylistDefinition.self, from: data), def)
    }

    func testSpeedResolutionPrefersPodcastOverride() {
        XCTAssertEqual(SmartEvaluator.resolveSpeed(defaultSpeed: 1.2, podcastSpeeds: ["p1": 1.8], podcastId: "p1"), 1.8)
        XCTAssertEqual(SmartEvaluator.resolveSpeed(defaultSpeed: 1.2, podcastSpeeds: ["p1": 1.8], podcastId: "p2"), 1.2)
        XCTAssertEqual(LocalData.roundSpeed(0.34), 0.5); XCTAssertEqual(LocalData.roundSpeed(3.4), 3.0); XCTAssertEqual(LocalData.roundSpeed(1.26), 1.3)
    }
}

@MainActor
final class DataLayerTests: XCTestCase {
    func makeData() throws -> LocalData { LocalData(db: try AppDatabase(inMemoryUserId: "0273fd19-62cc-411d-9c77-9f1e249a7591")) }

    func testDeterministicIdsMatchWebClient() {
        let u = "0273fd19-62cc-411d-9c77-9f1e249a7591", e = "e958e5b1-8949-4b3c-b847-4d569915eda6"
        XCTAssertEqual(RecordID.state(userId: u, episodeId: e), "0273fd1962cc411d9c77" + "9f1e249a7591" + "e958e5b189494b3c" + "b847" + "4d569915eda6")
        XCTAssertEqual(RecordID.state(userId: u, episodeId: e).count, 64)
        XCTAssertEqual(RecordID.settings(userId: u), "s0273fd1962cc411d9c779f1e249a7591")
        XCTAssertEqual(RecordID.upNext(userId: u), "q0273fd1962cc411d9c779f1e249a7591")
    }

    func testLocalWritesQueueOutboxAndQueueOrdering() throws {
        let data = try makeData()
        data.enqueue("a", .last); data.enqueue("b", .last); data.enqueue("c", .front)
        XCTAssertEqual(data.queueIds(), ["c", "a", "b"])
        data.enqueue("b", .next, currentId: "c")
        XCTAssertEqual(data.queueIds(), ["c", "b", "a"])
        data.dequeue("c")
        XCTAssertEqual(data.queueIds(), ["b", "a"])
        let pending = try data.db.pool.read { try OutboxEntry.fetchAll($0) }
        XCTAssertTrue(pending.contains { $0.collection == "playlists" && $0.recordId == RecordID.upNext(userId: data.userId) })
    }

    func testPlayedStatePositionAndSpeedOverrides() throws {
        let data = try makeData()
        data.savePosition("ep1", positionMs: 30_000, durationMs: 600_000)
        XCTAssertEqual(data.state(for: "ep1").status, .inProgress)
        data.savePosition("ep1", positionMs: 598_000, durationMs: 600_000)
        XCTAssertEqual(data.state(for: "ep1").status, .played)
        data.markUnplayed("ep1")
        XCTAssertEqual(data.state(for: "ep1").positionMs, 0)
        data.setDefaultSpeed(1.4); data.setPodcastSpeed("p1", 2.0)
        XCTAssertEqual(data.settings().defaultSpeed, 1.4); XCTAssertEqual(data.settings().podcastSpeeds["p1"], 2.0)
        data.setPodcastSpeed("p1", nil)
        XCTAssertNil(data.settings().podcastSpeeds["p1"])
        data.setCleanupDays("p1", 7)
        XCTAssertEqual(data.settings().cleanupDays["p1"], 7)
    }

    func testSyncRecordsEncodeToServerSchema() throws {
        let s = EpisodeState(id: "x", episodeId: "e", status: .inProgress, positionMs: 91000, clientUpdatedAt: 1731200000000)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any])
        XCTAssertEqual(obj["positionMs"] as? Int, 91000)
        XCTAssertNil(obj["positionUpdatedAt"], "nil optionals must be omitted: the server schema rejects null here")
        XCTAssertEqual(obj["deleted"] as? Bool, false)
        let dec = try JSONDecoder().decode(EpisodeState.self, from: Data(#"{"id":"a","userId":"u","episodeId":"e","status":"played","positionMs":5,"starred":true,"clientUpdatedAt":9,"rev":12,"deleted":false}"#.utf8))
        XCTAssertEqual(dec.status, .played); XCTAssertTrue(dec.starred)
    }

    func testBookmarkLifecycle() throws {
        let data = try makeData()
        let b = data.addBookmark(episodeId: "e", positionMs: 12_000, title: "  Great bit ", note: nil)
        XCTAssertEqual(b.title, "Great bit")
        data.updateBookmark(b.id, title: "Renamed", note: "n")
        data.deleteBookmark(b.id)
        let rec = try XCTUnwrap(try data.db.pool.read { try Bookmark.fetchOne($0, key: b.id) })
        XCTAssertTrue(rec.deleted); XCTAssertEqual(rec.title, "Renamed")
    }
}
