import BackgroundTasks
import Foundation
import GRDB
import Network
import Observation
import UIKit
import UserNotifications

/// Observes connectivity (Wi-Fi-only downloads, "connectivity regained" sync trigger).
@MainActor @Observable
final class NetworkMonitor {
    static let shared = NetworkMonitor()
    private(set) var isOnline = true
    private(set) var isExpensive = false
    var onRegained: (() -> Void)?
    private let monitor = NWPathMonitor()
    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let was = self.isOnline
                self.isOnline = path.status == .satisfied
                self.isExpensive = path.isExpensive
                if !was && self.isOnline { self.onRegained?() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.homecast.net"))
    }
}

// MARK: wire format (shared/src/sync.ts)

private struct SyncChanges: Encodable {
    var episodeStates: [EpisodeState] = []
    var bookmarks: [Bookmark] = []
    var playlists: [Playlist] = []
    var smartPlaylists: [SmartPlaylist] = []
    var settings: [UserSettings] = []
    var subscriptions: [Subscription] = []
}
private struct SyncRequest: Encodable { var cursor: Int; var deviceId: String; var changes: SyncChanges }

/// A shared record plus its tombstone flag (podcasts/episodes carry `deleted` but the local row doesn't).
private struct Shared<T: Decodable>: Decodable {
    let value: T
    let deleted: Bool
    private struct K: CodingKey { var stringValue: String; var intValue: Int? { nil }; init?(stringValue: String) { self.stringValue = stringValue }; init?(intValue: Int) { nil } }
    init(from d: Decoder) throws {
        value = try T(from: d)
        deleted = (try? d.container(keyedBy: K.self).decodeIfPresent(Bool.self, forKey: K(stringValue: "deleted")!)) ?? false
    }
}
private struct SyncResponse: Decodable {
    struct Changes: Decodable {
        var podcasts: [Shared<Podcast>] = []
        var episodes: [Shared<Episode>] = []
        var episodeStates: [EpisodeState] = []
        var bookmarks: [Bookmark] = []
        var playlists: [Playlist] = []
        var smartPlaylists: [SmartPlaylist] = []
        var settings: [UserSettings] = []
        var subscriptions: [Subscription] = []
    }
    var cursor: Int
    var hasMore: Bool
    var fullResync: Bool?
    var rejected: [SyncRejected] = []
    var changes: Changes
}

/// A synced per-user record type, for the generic merge.
protocol SyncRecord: PersistableRecord, FetchableRecord, Identifiable where ID == String {
    static var collection: String { get }
    /// Column of a natural key with one row per user (episode state per episode, subscription per podcast).
    static var naturalKey: (column: String, value: (Self) -> String)? { get }
    var clientUpdatedAt: Int { get }
}
extension EpisodeState: SyncRecord { static var collection: String { "episodeStates" }; static var naturalKey: (column: String, value: (EpisodeState) -> String)? { ("episodeId", { $0.episodeId }) } }
extension Subscription: SyncRecord { static var collection: String { "subscriptions" }; static var naturalKey: (column: String, value: (Subscription) -> String)? { ("podcastId", { $0.podcastId }) } }
extension Bookmark: SyncRecord { static var collection: String { "bookmarks" }; static var naturalKey: (column: String, value: (Bookmark) -> String)? { nil } }
extension Playlist: SyncRecord { static var collection: String { "playlists" }; static var naturalKey: (column: String, value: (Playlist) -> String)? { nil } }
extension SmartPlaylist: SyncRecord { static var collection: String { "smartPlaylists" }; static var naturalKey: (column: String, value: (SmartPlaylist) -> String)? { nil } }
extension UserSettings: SyncRecord { static var collection: String { "settings" }; static var naturalKey: (column: String, value: (UserSettings) -> String)? { nil } }

/// Delta sync (spec §5): push outbox records, pull everything after `cursor`, repeat while `hasMore`.
/// Conflicts are resolved server-side (last-write-wins); locally a pending change newer than an incoming record is kept.
@MainActor @Observable
final class SyncEngine {
    enum State: Equatable { case idle, syncing, offline, error }
    private(set) var state: State = .idle
    private(set) var lastSyncAt: Date?
    private(set) var errorMessage: String?

    let db: AppDatabase
    let api: APIClient
    var onMerged: (() -> Void)?

    @ObservationIgnored private var running: Task<Void, Never>?
    @ObservationIgnored private var again = false
    @ObservationIgnored private var debounce: Task<Void, Never>?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var backoff: Double = 0

    init(db: AppDatabase, api: APIClient) {
        self.db = db
        self.api = api
    }

    func start() {
        NetworkMonitor.shared.onRegained = { [weak self] in self?.schedule(after: 0) }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in await self?.sync() } }
        schedule(after: 0)
    }
    func stop() {
        timer?.invalidate(); debounce?.cancel(); running?.cancel()
    }

    /// Debounced sync after local writes.
    func schedule(after seconds: Double = 2) {
        debounce?.cancel()
        debounce = Task { [weak self] in
            if seconds > 0 { try? await Task.sleep(for: .seconds(seconds)) }
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    func sync() async {
        if let running { again = true; await running.value; return }
        let task = Task<Void, Never> { [weak self] in await self?.run() }
        running = task
        await task.value
        running = nil
        if again { again = false; schedule(after: 0.3) }
    }

    private func deviceId() -> String {
        if let id = db.kv("deviceId") { return id }
        let id = RecordID.new()
        db.setKV("deviceId", id)
        return id
    }

    private func run() async {
        state = .syncing
        do {
            let device = deviceId()
            for round in 0 ..< 50 {
                var cursor = db.kvInt("cursor")
                let (changes, sent) = try await db.pool.read { d in try Self.collectDirty(d) }
                let res: SyncResponse = try await api.sendEncodable("POST", "/sync", body: SyncRequest(cursor: cursor, deviceId: device, changes: changes))
                if res.fullResync == true { try await resetSynced(); cursor = 0 }
                try await merge(res, sent: sent)
                db.setKV("cursor", String(res.cursor))
                let dirty = try await db.pool.read { try OutboxEntry.fetchCount($0) }
                if !res.hasMore && res.fullResync != true && dirty == 0 { break }
                if !res.hasMore && res.fullResync != true && dirty > 0 && round > 3 { break }
            }
            backoff = 0
            state = .idle
            lastSyncAt = Date()
            errorMessage = nil
            onMerged?()
        } catch is CancellationError {
            state = .idle
        } catch {
            let offline = error is NetworkError
            state = offline ? .offline : .error
            errorMessage = error.localizedDescription
            backoff = min(backoff > 0 ? backoff * 2 : 5, 300)
            schedule(after: offline ? 15 : backoff)
        }
    }

    // MARK: collect / merge

    private struct Sent { var collection: String; var id: String; var clientUpdatedAt: Int }

    private nonisolated static func collectDirty(_ d: Database) throws -> (SyncChanges, [Sent]) {
        var changes = SyncChanges()
        var sent: [Sent] = []
        func load<R: SyncRecord>(_ type: R.Type) throws -> [R] {
            let ids = try OutboxEntry.filter(Column("collection") == R.collection).limit(2000).fetchAll(d).map(\.recordId)
            let rows = try R.fetchAll(d, keys: ids)
            sent += rows.map { Sent(collection: R.collection, id: $0.id, clientUpdatedAt: $0.clientUpdatedAt) }
            // Outbox entries whose row vanished are stale: drop them.
            let have = Set(rows.map(\.id))
            for id in ids where !have.contains(id) { _ = try OutboxEntry.deleteOne(d, key: ["collection": R.collection, "recordId": id]) }
            return rows
        }
        changes.episodeStates = try load(EpisodeState.self)
        changes.bookmarks = try load(Bookmark.self)
        changes.playlists = try load(Playlist.self)
        changes.smartPlaylists = try load(SmartPlaylist.self)
        changes.settings = try load(UserSettings.self)
        changes.subscriptions = try load(Subscription.self)
        return (changes, sent)
    }

    private func resetSynced() async throws {
        try await db.pool.write { d in
            try Podcast.deleteAll(d)
            try Episode.deleteAll(d)
            func clear<R: SyncRecord>(_ t: R.Type) throws {
                let dirty = try OutboxEntry.filter(Column("collection") == R.collection).fetchAll(d).map(\.recordId)
                try R.filter(!dirty.contains(Column("id"))).deleteAll(d)
            }
            try clear(EpisodeState.self); try clear(Bookmark.self); try clear(Playlist.self)
            try clear(SmartPlaylist.self); try clear(UserSettings.self); try clear(Subscription.self)
        }
    }

    private func merge(_ res: SyncResponse, sent: [Sent]) async throws {
        try await db.pool.write { d in
            for p in res.changes.podcasts {
                if p.deleted { _ = try Podcast.deleteOne(d, key: p.value.id) } else { try p.value.save(d) }
            }
            for e in res.changes.episodes {
                if e.deleted { _ = try Episode.deleteOne(d, key: e.value.id) } else { try e.value.save(d) }
            }
            let rejected = Set(res.rejected.map { "\($0.collection):\($0.id)" })
            func mergeUser<R: SyncRecord>(_ incoming: [R]) throws {
                let outbox = Set(try OutboxEntry.filter(Column("collection") == R.collection).fetchAll(d).map(\.recordId))
                for rec in incoming {
                    let pending = outbox.contains(rec.id)
                    if pending, let local = try R.fetchOne(d, key: rec.id), local.clientUpdatedAt > rec.clientUpdatedAt { continue }
                    // A different local id for the same natural key means the server kept its own row: adopt it.
                    if let nk = R.naturalKey {
                        let dupes = try R.filter(Column(nk.column) == nk.value(rec)).fetchAll(d)
                        for dup in dupes where dup.id != rec.id && !outbox.contains(dup.id) { _ = try R.deleteOne(d, key: dup.id) }
                    }
                    try rec.save(d)
                    _ = try OutboxEntry.deleteOne(d, key: ["collection": R.collection, "recordId": rec.id])
                }
            }
            try mergeUser(res.changes.episodeStates); try mergeUser(res.changes.bookmarks); try mergeUser(res.changes.playlists)
            try mergeUser(res.changes.smartPlaylists); try mergeUser(res.changes.settings); try mergeUser(res.changes.subscriptions)

            // Acknowledge what we sent: rejected ids would be re-sent forever, and unchanged rows are now on the server.
            func ack<R: SyncRecord>(_ t: R.Type) throws {
                for s in sent where s.collection == R.collection {
                    let key: [String: DatabaseValueConvertible] = ["collection": s.collection, "recordId": s.id]
                    if rejected.contains("\(s.collection):\(s.id)") { _ = try OutboxEntry.deleteOne(d, key: key); continue }
                    if let cur = try R.fetchOne(d, key: s.id), cur.clientUpdatedAt == s.clientUpdatedAt { _ = try OutboxEntry.deleteOne(d, key: key) }
                }
            }
            try ack(EpisodeState.self); try ack(Bookmark.self); try ack(Playlist.self); try ack(SmartPlaylist.self); try ack(UserSettings.self); try ack(Subscription.self)
        }
    }
}


// MARK: - New episode notifications
//
// A self-hosted server has no push service, so the app asks for new episodes itself: a background refresh syncs, and
// anything released since the last check (in a podcast whose bell is on) becomes a local notification. iOS decides when
// background refreshes run (often a few times a day), so these can arrive later than the episode itself.

extension DeviceSettings {
    /// Notify about new episodes on this device (the per-podcast bell is synced; this switch is per device).
    static var notifyNewEpisodes: Bool {
        get { UserDefaults.standard.bool(forKey: "hc.notifyNew") }
        set { UserDefaults.standard.set(newValue, forKey: "hc.notifyNew") }
    }
}

/// Carries a tapped notification to the UI.
@MainActor @Observable
final class NotificationRouter {
    static let shared = NotificationRouter()
    var episodeId: String?
}

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let id = response.notification.request.content.userInfo["episodeId"] as? String else { return }
        await MainActor.run { NotificationRouter.shared.episodeId = id }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
}

@MainActor
enum NewEpisodeNotifier {
    static let taskId = "app.homecast.refresh"
    private static let delegate = NotificationDelegate()
    private static let maxSeen = 400

    /// Call once at launch.
    static func register() {
        UNUserNotificationCenter.current().delegate = delegate
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            Task { @MainActor in await handle(task) }
        }
    }

    /// Ask the system for permission; on success start tracking from now so old episodes don't flood in.
    static func enable() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { return false }
        DeviceSettings.notifyNewEpisodes = true
        AppEnvironment.shared.workspace?.db.setKV("notify.since", String(Int(Date().timeIntervalSince1970 * 1000)))
        schedule()
        return true
    }
    static func disable() {
        DeviceSettings.notifyNewEpisodes = false
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
    }
    static func authorizationDenied() async -> Bool { await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .denied }

    /// Ask iOS for a refresh in about 30 minutes (it may run later, or not at all if the phone is idle or in Low Power Mode).
    static func schedule() {
        guard DeviceSettings.notifyNewEpisodes else { return }
        let req = BGAppRefreshTaskRequest(identifier: taskId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    private static func handle(_ task: BGAppRefreshTask) async {
        schedule() // keep the chain going
        let work = Task { @MainActor in
            // Launched in the background: the workspace restores asynchronously, so give it a moment.
            for _ in 0 ..< 40 where AppEnvironment.shared.workspace == nil { try? await Task.sleep(for: .milliseconds(250)) }
            guard let ws = AppEnvironment.shared.workspace else { return false }
            await ws.sync.sync()
            await check(ws, notify: true)
            return true
        }
        task.expirationHandler = { work.cancel() }
        task.setTaskCompleted(success: await work.value)
    }

    /// Look for episodes released since the last check in podcasts with the bell on. With `notify: false` they are only
    /// marked as seen (used when the app is open: you don't need a banner for what is on screen).
    static func check(_ ws: Workspace, notify: Bool) async {
        guard DeviceSettings.notifyNewEpisodes else { return }
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        guard let since = ws.db.kv("notify.since").flatMap(Int.init) else { ws.db.setKV("notify.since", String(nowMs)); return }
        var seen = ws.db.kvJSON("notify.seen", as: [String].self) ?? []
        let seenSet = Set(seen)
        struct Fresh { var episode: Episode; var podcast: String }
        let fresh: [Fresh] = (try? await ws.db.pool.read { d in
            let podcastIds = try Subscription.filter(Column("deleted") == false).filter(Column("newEpisodeNotify") == true).fetchAll(d).map(\.podcastId)
            guard !podcastIds.isEmpty else { return [] }
            let eps = try Episode.filter(podcastIds.contains(Column("podcastId"))).filter(Column("releasedAt") > since).order(Column("releasedAt").desc).limit(100).fetchAll(d)
            let played = Set(try EpisodeState.filter(keys: eps.map { RecordID.state(userId: ws.user.id, episodeId: $0.id) }).filter(Column("status") == PlayStatus.played).fetchAll(d).map(\.episodeId))
            let titles = Dictionary(uniqueKeysWithValues: try Podcast.filter(keys: podcastIds).fetchAll(d).map { ($0.id, $0.title) })
            return eps.filter { !played.contains($0.id) && !seenSet.contains($0.id) && $0.releasedAt < nowMs + 86_400_000 }.map { Fresh(episode: $0, podcast: titles[$0.podcastId] ?? "New episode") }
        }) ?? []
        guard !fresh.isEmpty else { return }
        seen.append(contentsOf: fresh.map(\.episode.id))
        ws.db.setKVJSON("notify.seen", Array(seen.suffix(maxSeen)))
        guard notify, await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .authorized else { return }
        for (podcastId, group) in Dictionary(grouping: fresh, by: \.episode.podcastId) {
            let content = UNMutableNotificationContent()
            content.title = group[0].podcast
            content.body = group.count == 1 ? group[0].episode.title : "\(group.count) new episodes: " + group.prefix(2).map(\.episode.title).joined(separator: ", ") + (group.count > 2 ? "…" : "")
            content.sound = .default
            content.threadIdentifier = podcastId
            content.userInfo = ["episodeId": group[0].episode.id]
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "new-\(podcastId)-\(group[0].episode.id)", content: content, trigger: nil))
        }
    }
}
