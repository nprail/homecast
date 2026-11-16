import Foundation
import Observation
import UIKit

/// Everything that exists while a user is signed in: their database, writers, sync and downloads.
@MainActor @Observable
final class Workspace {
    let user: UserDTO
    let api: APIClient
    let db: AppDatabase
    let data: LocalData
    let sync: SyncEngine
    let player: Player
    private(set) var downloads: DownloadManager!

    init(user: UserDTO, api: APIClient, player: Player) throws {
        self.user = user
        self.api = api
        self.player = player
        db = try AppDatabase(userId: user.id)
        data = LocalData(db: db)
        sync = SyncEngine(db: db, api: api)
        data.sync = sync
        downloads = DownloadManager(db: db, workspace: { [weak self] in self })
        player.workspace = self
        sync.onMerged = { [weak self] in
            guard let self else { return }
            self.downloads.runAutoDownloads()
            self.downloads.cleanup()
            self.player.refreshSpeed()
        }
    }
}

enum AuthState: Equatable { case launching, signedOut, signedIn }

/// App-wide singleton. It lives outside any SwiftUI view because CarPlay can launch the app (and the
/// player) with no phone UI on screen.
@MainActor @Observable
final class AppEnvironment {
    static let shared = AppEnvironment()

    private(set) var state: AuthState = .launching
    private(set) var workspace: Workspace?
    let player = Player()
    private(set) var api: APIClient
    var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: "hc.serverURL") }
    }

    var onWorkspaceChange: ((Workspace?) -> Void)?

    private init() {
        let saved = UserDefaults.standard.string(forKey: "hc.serverURL") ?? ""
        serverURLString = saved
        api = APIClient(baseURL: URL(string: saved.isEmpty ? "http://localhost:8080" : saved) ?? URL(string: "http://localhost:8080")!)
        Task { await self.bootstrap() }
    }

    /// Restore a saved session (works offline: the stored user and local database are enough).
    private func bootstrap() async {
        await api.setOnSessionLost { [weak self] in Task { @MainActor in self?.signedOut() } }
        if let data = UserDefaults.standard.data(forKey: "hc.user"), let user = try? JSONDecoder().decode(UserDTO.self, from: data), await api.hasCredentials {
            activate(user)
        } else {
            state = .signedOut
            #if DEBUG
            // Test/screenshot hook: HC_AUTOLOGIN="server|user|password" signs in at launch.
            if let creds = ProcessInfo.processInfo.environment["HC_AUTOLOGIN"]?.split(separator: "|", omittingEmptySubsequences: false).map(String.init), creds.count == 3 {
                try? await signIn(server: creds[0], username: creds[1], password: creds[2])
            }
            #endif
        }
    }

    static func normalizedURL(_ s: String) -> URL? {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        if !t.contains("://") { t = "https://" + t }
        while t.hasSuffix("/") { t.removeLast() }
        guard let u = URL(string: t), u.host != nil else { return nil }
        return u
    }

    func signIn(server: String, username: String, password: String) async throws {
        guard let url = Self.normalizedURL(server) else { throw APIError(status: 0, message: "Enter your server address, e.g. podcasts.example.com", code: nil) }
        await api.setBaseURL(url)
        let auth = try await api.login(username: username, password: password, deviceName: Self.deviceName)
        serverURLString = url.absoluteString
        finishAuth(auth)
    }

    func register(server: String, username: String, password: String, inviteCode: String?, bootstrapToken: String?) async throws {
        guard let url = Self.normalizedURL(server) else { throw APIError(status: 0, message: "Enter your server address, e.g. podcasts.example.com", code: nil) }
        await api.setBaseURL(url)
        let auth = try await api.register(username: username, password: password, inviteCode: inviteCode, bootstrapToken: bootstrapToken, deviceName: Self.deviceName)
        serverURLString = url.absoluteString
        finishAuth(auth)
    }

    private func finishAuth(_ auth: AuthResponse) {
        if let d = try? JSONEncoder().encode(auth.user) { UserDefaults.standard.set(d, forKey: "hc.user") }
        activate(auth.user)
    }

    private func activate(_ user: UserDTO) {
        do {
            let ws = try Workspace(user: user, api: api, player: player)
            workspace = ws
            state = .signedIn
            ws.sync.start()
            Task { await player.restore() }
            onWorkspaceChange?(ws)
        } catch {
            state = .signedOut
        }
    }

    func signOut() async {
        await api.logout()
        signedOut()
    }

    private func signedOut() {
        player.pause()
        workspace?.sync.stop()
        workspace?.downloads.removeAll()
        workspace = nil
        UserDefaults.standard.removeObject(forKey: "hc.user")
        state = .signedOut
        onWorkspaceChange?(nil)
    }

    static var deviceName: String { UIDevice.current.model } // generic on purpose: no personal device names leave the phone
}
