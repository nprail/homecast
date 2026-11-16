import Foundation

// MARK: DTOs (shared/src/api.ts, sync.ts)

struct UserDTO: Codable, Hashable {
    var id: String
    var username: String
    var role: String
    var isAdmin: Bool { role == "admin" }
}

struct AuthResponse: Decodable {
    var user: UserDTO
    var accessToken: String
    var accessTokenExpiresAt: Double
    var refreshToken: String?
}

struct SessionDTO: Decodable, Identifiable, Hashable {
    var id: String
    var deviceName: String
    var createdAt: Double
    var lastUsedAt: Double
    var current: Bool
}

struct DiscoverItem: Decodable, Identifiable, Hashable {
    var id: String
    var title: String
    var author: String
    var imageUrl: String?
    var description: String
    var subscriberCount: Int
    var addedAt: Double
}
struct DiscoverResponse: Decodable { var total: Int; var items: [DiscoverItem] }

struct TranscriptResponse: Decodable {
    struct Job: Decodable { var status: String; var stage: String?; var progress: Double?; var queuePosition: Int? }
    var status: String
    var source: String?
    var model: String?
    var segments: [TranscriptSegment]?
    var job: Job?
}

/// `GET /search/transcripts`: episodes whose transcripts match, with the matching lines.
struct TranscriptSearchHit: Decodable, Hashable { var startMs: Int; var text: String }
struct TranscriptSearchItem: Decodable, Identifiable, Hashable {
    var episodeId: String
    var podcastId: String
    var episodeTitle: String
    var podcastTitle: String
    var releasedAt: Double
    var matches: Int
    var hits: [TranscriptSearchHit]
    var id: String { episodeId }
}
struct TranscriptSearchResponse: Decodable { var total: Int; var items: [TranscriptSearchItem] }

/// `GET /episodes/:id/chapters`. `source` is "json" (publisher file), "feed" (written into the feed) or "description" (show-note timestamps).
struct Chapter: Codable, Hashable {
    var startMs: Int
    var title: String
    var img: String?
    var url: String?
}
struct ChaptersResponse: Decodable { var source: String; var chapters: [Chapter] }

struct AddPodcastResponse: Decodable {
    struct P: Decodable { var id: String; var title: String }
    var podcast: P
}

struct OPMLImportResponse: Decodable {
    struct Failure: Decodable { var url: String; var error: String }
    var imported: Int
    var alreadySubscribed: Int?
    var failed: [Failure]
    /// "Imported 3 podcasts, 2 already subscribed, 1 failed".
    var summary: String {
        var parts = ["Imported \(Fmt.plural(imported, "podcast"))"]
        if let n = alreadySubscribed, n > 0 { parts.append("\(n) already subscribed") }
        if !failed.isEmpty { parts.append("\(failed.count) failed") }
        return parts.joined(separator: ", ")
    }
}

struct SyncRejected: Decodable { var collection: String; var id: String; var reason: String }

/// `GET /episodes/:id/stream`: a signed, short-lived URL for a copy the server hosts, or `url == nil` when it doesn't.
struct StreamResponse: Decodable {
    var url: String?
    var expiresAt: Double?
}

// MARK: errors

/// The server could not be reached (as opposed to it answering with an error).
struct NetworkError: LocalizedError {
    var errorDescription: String? { "You're offline, or the server can't be reached." }
}
struct APIError: LocalizedError {
    var status: Int
    var message: String
    var code: String?
    var errorDescription: String? { message }
}

// MARK: client

/// Talks to the Homecast server (`/api/v1`). Holds the access token in memory (and Keychain), refreshes it
/// on expiry or 401 using the rotating refresh token (spec §7), and distinguishes "offline" from real errors.
actor APIClient {
    private(set) var baseURL: URL
    private var accessToken: String?
    private var accessExpiry: Double = 0
    private var refreshing: Task<Bool, Never>?
    private let session: URLSession
    var onSessionLost: (@Sendable () -> Void)?

    /// `configuration` lets tests substitute a URLProtocol stub; the app uses the default.
    init(baseURL: URL, configuration: URLSessionConfiguration = .default) {
        self.baseURL = baseURL
        let cfg = configuration
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg)
        accessToken = Keychain.get("accessToken")
        accessExpiry = Double(Keychain.get("accessExpiry") ?? "") ?? 0
    }

    func setBaseURL(_ url: URL) { baseURL = url }
    func setOnSessionLost(_ f: @escaping @Sendable () -> Void) { onSessionLost = f }

    func store(_ auth: AuthResponse) {
        accessToken = auth.accessToken
        accessExpiry = auth.accessTokenExpiresAt
        Keychain.set(auth.accessToken, for: "accessToken")
        Keychain.set(String(auth.accessTokenExpiresAt), for: "accessExpiry")
        if let r = auth.refreshToken { Keychain.set(r, for: "refreshToken") }
    }
    func clear() {
        accessToken = nil; accessExpiry = 0
        ["accessToken", "accessExpiry", "refreshToken"].forEach { Keychain.set(nil, for: $0) }
    }
    var hasCredentials: Bool { accessToken != nil || Keychain.get("refreshToken") != nil }

    // MARK: auth

    func login(username: String, password: String, deviceName: String) async throws -> AuthResponse {
        let r: AuthResponse = try await send("POST", "/auth/login", json: ["username": username, "password": password, "deviceName": deviceName, "client": "native"], auth: false)
        store(r)
        return r
    }

    func register(username: String, password: String, inviteCode: String?, bootstrapToken: String?, deviceName: String) async throws -> AuthResponse {
        var body: [String: Any] = ["username": username, "password": password, "deviceName": deviceName, "client": "native"]
        if let inviteCode, !inviteCode.isEmpty { body["inviteCode"] = inviteCode }
        if let bootstrapToken, !bootstrapToken.isEmpty { body["bootstrapToken"] = bootstrapToken }
        let r: AuthResponse = try await send("POST", "/auth/register", json: body, auth: false)
        store(r)
        return r
    }

    func logout() async {
        let refresh = Keychain.get("refreshToken")
        _ = try? await sendRaw("POST", "/auth/logout", json: refresh.map { ["refreshToken": $0] } ?? [:], auth: true, retry: false)
        clear()
    }

    /// Exchanges the refresh token. Returns false if the server says the session is gone; throws NetworkError offline.
    func refresh() async throws -> Bool {
        if let t = refreshing { return await t.value }
        guard let rt = Keychain.get("refreshToken") else { return false }
        let task = Task<Bool, Never> { [self] in
            do {
                let (data, status) = try await self.sendRaw("POST", "/auth/refresh", json: ["refreshToken": rt], auth: false, retry: false)
                guard (200 ..< 300).contains(status), let r = try? JSONDecoder().decode(AuthResponse.self, from: data) else { return false }
                self.store(r)
                return true
            } catch { return true } // offline: keep the session, retry later
        }
        refreshing = task
        let ok = await task.value
        refreshing = nil
        return ok
    }

    // MARK: requests

    func get<T: Decodable>(_ path: String) async throws -> T { try await send("GET", path) }

    /// A signed URL to stream the server's hosted copy of an episode (episode hosting), valid for hours and playable
    /// without an Authorization header. `nil` when the episode isn't hosted or the server can't be reached within a
    /// few seconds; the caller then streams from the podcast's own URL.
    func signedStreamURL(for episodeId: String) async -> URL? {
        let fetch = Task { () -> StreamResponse in try await self.get("/episodes/\(episodeId)/stream") }
        let watchdog = Task { try? await Task.sleep(for: .seconds(4)); fetch.cancel() }
        defer { watchdog.cancel() }
        guard let r = try? await fetch.value, let path = r.url else { return nil }
        return URL(string: path, relativeTo: baseURL)?.absoluteURL
    }
    func post<T: Decodable>(_ path: String, json: [String: Any]? = nil) async throws -> T { try await send("POST", path, json: json) }

    func send<T: Decodable>(_ method: String, _ path: String, json: [String: Any]? = nil, auth: Bool = true) async throws -> T {
        let (data, _) = try await sendOK(method, path, json: json, auth: auth)
        if T.self == EmptyResponse.self { return EmptyResponse() as! T }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw APIError(status: 0, message: "Unexpected response from the server.", code: "decode") }
    }

    func sendEncodable<B: Encodable, T: Decodable>(_ method: String, _ path: String, body: B) async throws -> T {
        let data = try JSONEncoder().encode(body)
        let (out, status) = try await sendRaw(method, path, bodyData: data, contentType: "application/json", auth: true, retry: true)
        guard (200 ..< 300).contains(status) else { throw Self.error(status, out) }
        return try JSONDecoder().decode(T.self, from: out)
    }

    func postText<T: Decodable>(_ path: String, text: String, contentType: String) async throws -> T {
        let (out, status) = try await sendRaw("POST", path, bodyData: Data(text.utf8), contentType: contentType, auth: true, retry: true)
        guard (200 ..< 300).contains(status) else { throw Self.error(status, out) }
        return try JSONDecoder().decode(T.self, from: out)
    }

    func getText(_ path: String) async throws -> String {
        let (out, status) = try await sendRaw("GET", path, auth: true, retry: true)
        guard (200 ..< 300).contains(status) else { throw Self.error(status, out) }
        return String(decoding: out, as: UTF8.self)
    }

    func delete(_ path: String) async throws {
        _ = try await sendOK("DELETE", path, json: nil, auth: true)
    }

    private func sendOK(_ method: String, _ path: String, json: [String: Any]?, auth: Bool) async throws -> (Data, Int) {
        let (data, status) = try await sendRaw(method, path, json: json, auth: auth, retry: true)
        guard (200 ..< 300).contains(status) else { throw Self.error(status, data) }
        return (data, status)
    }

    private static func error(_ status: Int, _ data: Data) -> APIError {
        struct Env: Decodable { struct E: Decodable { var message: String?; var code: String? }; var error: E? }
        let e = (try? JSONDecoder().decode(Env.self, from: data))?.error
        return APIError(status: status, message: e?.message ?? "Request failed (\(status))", code: e?.code)
    }

    func sendRaw(_ method: String, _ path: String, json: [String: Any]? = nil, auth: Bool, retry: Bool) async throws -> (Data, Int) {
        let body = try json.map { try JSONSerialization.data(withJSONObject: $0) }
        return try await sendRaw(method, path, bodyData: body, contentType: body == nil ? nil : "application/json", auth: auth, retry: retry)
    }

    func sendRaw(_ method: String, _ path: String, bodyData: Data? = nil, contentType: String? = nil, auth: Bool, retry: Bool) async throws -> (Data, Int) {
        if auth, accessToken == nil || Date().timeIntervalSince1970 * 1000 > accessExpiry - 60_000, Keychain.get("refreshToken") != nil, retry {
            if !(try await refresh()) { await sessionLost(); throw APIError(status: 401, message: "Your session has ended. Sign in again.", code: "unauthorized") }
        }
        var req = URLRequest(url: URL(string: "/api/v1" + path, relativeTo: baseURL)!.absoluteURL)
        req.httpMethod = method
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "content-type") }
        if let bodyData { req.httpBody = bodyData }
        if auth, let t = accessToken { req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization") }
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: req) }
        catch let e as URLError where [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .timedOut, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff].contains(e.code) { throw NetworkError() }
        catch { throw error }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401, auth, retry {
            if try await refresh() { return try await sendRaw(method, path, bodyData: bodyData, contentType: contentType, auth: auth, retry: false) }
            await sessionLost()
        }
        return (data, status)
    }

    private func sessionLost() async {
        clear()
        onSessionLost?()
    }

    /// For requests that can't use `URLSession`'s normal flow. Audio doesn't need it: the player streams from the podcast's own URL,
    /// or from a signed URL for the server's hosted copy (`signedStreamURL`), which carries its own authorisation.
    func authHeader() -> String? { accessToken.map { "Bearer \($0)" } }
}

struct EmptyResponse: Decodable {}
