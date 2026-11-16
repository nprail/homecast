import Foundation
import GRDB
import Observation

/// Device-local download settings (spec §3.5). Not synced.
enum DeviceSettings {
    static var wifiOnly: Bool {
        get { UserDefaults.standard.object(forKey: "hc.wifiOnly") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "hc.wifiOnly") }
    }
    /// 0 = unlimited.
    static var storageCapMB: Int {
        get { UserDefaults.standard.integer(forKey: "hc.storageCapMB") }
        set { UserDefaults.standard.set(newValue, forKey: "hc.storageCapMB") }
    }
}

/// Offline audio (spec §3.5). Episodes download with a background `URLSession` straight from the podcast CDN
/// into Application Support/Downloads, so they continue while the app is suspended.
@MainActor @Observable
final class DownloadManager: NSObject {
    /// episodeId -> 0...1 (or -1 while queued).
    private(set) var active: [String: Double] = [:]
    private(set) var errors: [String: String] = [:]

    @ObservationIgnored private let workspace: () -> Workspace?
    @ObservationIgnored private let db: AppDatabase
    @ObservationIgnored private var session: URLSession!
    @ObservationIgnored static var backgroundCompletion: (() -> Void)?

    static var directory: URL {
        let d = AppDatabase.supportDirectory().appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    init(db: AppDatabase, workspace: @escaping () -> Workspace?) {
        self.db = db
        self.workspace = workspace
        super.init()
        let cfg = URLSessionConfiguration.background(withIdentifier: "app.homecast.downloads")
        cfg.sessionSendsLaunchEvents = true
        cfg.isDiscretionary = false
        cfg.waitsForConnectivity = true
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        session.getAllTasks { [weak self] tasks in
            Task { @MainActor in
                for t in tasks { if let id = t.taskDescription { self?.active[id] = self?.active[id] ?? -1 } }
            }
        }
    }

    // MARK: queries

    func fileURL(for episodeId: String) -> URL? {
        guard let d = try? db.pool.read({ try Download.fetchOne($0, key: episodeId) }) else { return nil }
        let url = Self.directory.appendingPathComponent(d.fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    func isDownloaded(_ episodeId: String) -> Bool { fileURL(for: episodeId) != nil }
    func totalBytes() -> Int { (try? db.pool.read { try Download.fetchAll($0).reduce(0) { $0 + $1.bytes } }) ?? 0 }

    private var networkAllowed: Bool { !(DeviceSettings.wifiOnly && NetworkMonitor.shared.isExpensive) }

    // MARK: actions

    func enqueue(_ episodeId: String) {
        guard active[episodeId] == nil, !isDownloaded(episodeId) else { return }
        guard let ep = try? db.pool.read({ try Episode.fetchOne($0, key: episodeId) }), let url = URL(string: ep.audioUrl) else {
            errors[episodeId] = "Episode not found"; return
        }
        errors[episodeId] = nil
        enforceCap(incoming: 0)
        var req = URLRequest(url: url)
        req.allowsCellularAccess = !DeviceSettings.wifiOnly
        req.allowsExpensiveNetworkAccess = !DeviceSettings.wifiOnly
        let task = session.downloadTask(with: req)
        task.taskDescription = episodeId
        active[episodeId] = -1
        task.resume()
    }

    func cancel(_ episodeId: String) {
        session.getAllTasks { tasks in tasks.filter { $0.taskDescription == episodeId }.forEach { $0.cancel() } }
        active[episodeId] = nil
    }

    func remove(_ episodeId: String) {
        cancel(episodeId)
        if let d = try? db.pool.read({ try Download.fetchOne($0, key: episodeId) }) {
            try? FileManager.default.removeItem(at: Self.directory.appendingPathComponent(d.fileName))
        }
        _ = try? db.pool.write { try Download.deleteOne($0, key: episodeId) }
    }

    func removeAll() {
        for d in (try? db.pool.read { try Download.fetchAll($0) }) ?? [] { remove(d.episodeId) }
    }

    /// Global storage cap: evict the oldest played downloads, then the oldest of all, to make room.
    func enforceCap(incoming: Int) {
        let capMB = DeviceSettings.storageCapMB
        guard capMB > 0 else { return }
        let cap = capMB * 1_000_000
        var total = totalBytes()
        guard total + incoming > cap else { return }
        let rows = ((try? db.pool.read { try Download.fetchAll($0) }) ?? []).sorted { $0.at < $1.at }
        let played = Set(((try? db.pool.read { try EpisodeState.filter(Column("status") == PlayStatus.played).fetchAll($0) }) ?? []).map(\.episodeId))
        for r in rows.filter({ played.contains($0.episodeId) }) + rows.filter({ !played.contains($0.episodeId) }) {
            if total + incoming <= cap { break }
            remove(r.episodeId)
            total -= r.bytes
        }
    }

    /// Per-podcast "delete played after N days" (spec §3.5).
    func cleanup() {
        guard let ws = workspace() else { return }
        let rules = ws.data.settings().cleanupDays
        for r in (try? db.pool.read { try Download.fetchAll($0) }) ?? [] {
            guard let days = rules[r.podcastId], days > 0 else { continue }
            let st = ws.data.state(for: r.episodeId)
            if st.status == .played, let at = st.playedAt, LocalData.nowMs() - at > days * 86_400_000 { remove(r.episodeId) }
        }
    }

    /// Auto-download rules (latest N / all new) and smart playlists flagged "auto-download results".
    func runAutoDownloads() {
        guard let ws = workspace(), networkAllowed else { return }
        var wanted = Set<String>()
        let subs = ((try? db.pool.read { try Subscription.filter(Column("deleted") == false).fetchAll($0) }) ?? []).filter { $0.autoDownload.mode != .off }
        let states = Dictionary(uniqueKeysWithValues: ((try? db.pool.read { try EpisodeState.fetchAll($0) }) ?? []).map { ($0.episodeId, $0) })
        for s in subs {
            let eps = (try? db.pool.read { try Episode.filter(Column("podcastId") == s.podcastId).order(Column("releasedAt").desc).fetchAll($0) }) ?? []
            if s.autoDownload.mode == .latest {
                for e in eps.prefix(s.autoDownload.count ?? 3) where states[e.id]?.status != .played { wanted.insert(e.id) }
            } else {
                // "all new": episodes released since the subscription was created.
                for e in eps.filter({ $0.releasedAt >= s.clientUpdatedAt && states[$0.id]?.status != .played }).prefix(20) { wanted.insert(e.id) }
            }
        }
        for p in ((try? db.pool.read { try SmartPlaylist.filter(Column("deleted") == false).fetchAll($0) }) ?? []) where p.definition.autoDownload == true {
            ws.data.evaluate(p.definition).prefix(25).forEach { wanted.insert($0) }
        }
        let have = Set(((try? db.pool.read { try Download.fetchAll($0) }) ?? []).map(\.episodeId))
        for id in wanted where !have.contains(id) { enqueue(id) }
    }

    fileprivate func finished(episodeId: String, tempURL: URL, response: URLResponse?) {
        guard let ep = try? db.pool.read({ try Episode.fetchOne($0, key: episodeId) }) else { return }
        let ext = Self.fileExtension(for: ep, response: response)
        let name = "\(episodeId).\(ext)"
        var dest = Self.directory.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: dest)
        do { try FileManager.default.moveItem(at: tempURL, to: dest) } catch { errors[episodeId] = "Could not save the download"; active[episodeId] = nil; return }
        var rv = URLResourceValues(); rv.isExcludedFromBackup = true
        try? dest.setResourceValues(rv)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? 0
        try? db.pool.write { try Download(episodeId: episodeId, podcastId: ep.podcastId, bytes: bytes, at: LocalData.nowMs(), fileName: name).save($0) }
        active[episodeId] = nil
        enforceCap(incoming: 0)
    }

    private static func fileExtension(for ep: Episode, response: URLResponse?) -> String {
        let path = URL(string: ep.audioUrl)?.pathExtension.lowercased() ?? ""
        if ["mp3", "m4a", "aac", "mp4", "wav", "ogg", "opus"].contains(path) { return path }
        switch (response?.mimeType ?? ep.mimeType).lowercased() {
        case "audio/mp4", "audio/x-m4a", "audio/m4a": return "m4a"
        case "audio/aac": return "aac"
        default: return "mp3"
        }
    }
}

extension DownloadManager: URLSessionDownloadDelegate {
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        // The temp file is deleted when this method returns, so move it synchronously first.
        let staged = FileManager.default.temporaryDirectory.appendingPathComponent("hc-\(UUID().uuidString)")
        let ok = (downloadTask.response as? HTTPURLResponse).map { (200 ..< 300).contains($0.statusCode) } ?? true
        guard ok, (try? FileManager.default.moveItem(at: location, to: staged)) != nil else {
            Task { @MainActor in self.errors[id] = "Download failed"; self.active[id] = nil }
            return
        }
        let response = downloadTask.response
        Task { @MainActor in self.finished(episodeId: id, tempURL: staged, response: response) }
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription, totalBytesExpectedToWrite > 0 else { return }
        let p = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        Task { @MainActor in self.active[id] = p }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription, let error else { return }
        if (error as? URLError)?.code == .cancelled { return }
        Task { @MainActor in self.errors[id] = "Download failed. It will be retried."; self.active[id] = nil }
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in DownloadManager.backgroundCompletion?(); DownloadManager.backgroundCompletion = nil }
    }
}
