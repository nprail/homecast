import GRDB
import SwiftUI

struct LibrarySnapshot: Sendable {
    var podcasts: [Podcast] = []
    var unplayed: [String: Int] = [:]
    var continueListening: [EpisodeItem] = []
    var starredCount = 0
    var bookmarkCount = 0
}

extension View {
    /// Navigation destinations shared by every tab's stack.
    func routes() -> some View {
        navigationDestination(for: Route.self) { r in
            switch r {
            case .podcast(let id): PodcastView(podcastId: id)
            case .episode(let id): EpisodeDetailView(episodeId: id)
            case .playlist(let id): PlaylistDetailView(playlistId: id)
            case .smartPlaylist(let id): SmartPlaylistDetailView(id: id)
            case .bookmarks: BookmarksView()
            case .starred: EpisodeListScreen(kind: .starred)
            case .latest: EpisodeListScreen(kind: .latest)
            }
        }
    }
}

struct SyncChip: View {
    @Environment(Workspace.self) private var ws
    var body: some View {
        let s = ws.sync
        Group {
            switch s.state {
            case .syncing: Label("Syncing", systemImage: "arrow.triangle.2.circlepath")
            case .offline: Label("Offline", systemImage: "wifi.slash")
            case .error: Label("Sync problem", systemImage: "exclamationmark.triangle.fill")
            case .idle: EmptyView()
            }
        }
        .font(.system(size: 12, weight: .semibold)).foregroundStyle(s.state == .error ? Brand.amber : Brand.muted)
    }
}

struct LibraryView: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    @StateObject private var lib: Live<LibrarySnapshot>
    @State private var path = NavigationPath()

    init() {
        let env = AppEnvironment.shared
        _lib = StateObject(wrappedValue: Live(LibrarySnapshot(), in: env.workspace?.db) { d in
            var snap = LibrarySnapshot()
            let subs = try d.subscribedPodcastIds()
            snap.podcasts = try Podcast.filter(keys: subs).order(sql: "title COLLATE NOCASE").fetchAll(d)
            let rows = try Row.fetchAll(d, sql: """
                SELECT e.podcastId AS pid, COUNT(*) AS n FROM episode e
                LEFT JOIN episodeState s ON s.episodeId = e.id AND s.deleted = 0
                WHERE (s.status IS NULL OR s.status != 'played') GROUP BY e.podcastId
                """)
            for r in rows { snap.unplayed[r["pid"]] = r["n"] }
            let inProgress = try EpisodeState.filter(Column("status") == PlayStatus.inProgress).filter(Column("deleted") == false)
                .order(Column("positionUpdatedAt").desc).limit(8).fetchAll(d)
            let eps = try Episode.filter(keys: inProgress.map(\.episodeId)).fetchAll(d)
            let byId = Dictionary(uniqueKeysWithValues: eps.map { ($0.id, $0) })
            snap.continueListening = try d.episodeItems(inProgress.compactMap { byId[$0.episodeId] }).filter { subs.contains($0.episode.podcastId) }
            snap.starredCount = try EpisodeState.filter(Column("starred") == true).filter(Column("deleted") == false).fetchCount(d)
            snap.bookmarkCount = try Bookmark.filter(Column("deleted") == false).fetchCount(d)
            return snap
        })
    }

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 220), spacing: 16)]

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    quickLinks
                    if !lib.value.continueListening.isEmpty { continueShelf }
                    if lib.value.podcasts.isEmpty {
                        EmptyState(icon: "waveform", title: "No podcasts yet", message: "Add a feed URL or import an OPML file, or browse what others on your server follow in Discover.")
                        PrimaryActionButton(title: "Add a Podcast", systemImage: "plus") { ui.showAddPodcast = true }.padding(.horizontal, 40)
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionLabel("Podcasts").padding(.horizontal, 20)
                            LazyVGrid(columns: columns, spacing: 20) {
                                ForEach(lib.value.podcasts) { p in
                                    NavigationLink(value: Route.podcast(p.id)) { PodcastTile(podcast: p, unplayed: lib.value.unplayed[p.id] ?? 0) }.buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 20)
                        }
                    }
                }
                .padding(.top, 4).padding(.bottom, 24)
            }
            .navigationTitle("Library")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SyncChip() }
                ToolbarItem(placement: .topBarTrailing) { Button { ui.showAddPodcast = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add podcast") }
            }
            .refreshable { await ws.sync.sync() }
            .brandScreen()
            .routes()
            .onAppear {
                #if DEBUG
                if let r = ProcessInfo.processInfo.environment["HC_ROUTE"] {
                    Task {
                        try? await Task.sleep(for: .seconds(4))
                        switch r {
                        case "podcast": if let id = lib.value.podcasts.first(where: { $0.title == "Signal & Noise" })?.id { path.append(Route.podcast(id)) }
                        case "episode": if let id = (try? await ws.db.pool.read { try Episode.filter(Column("guid") == "signal-0").fetchOne($0)?.id }) ?? nil { path.append(Route.episode(id)) }
                        case "bookmarks": path.append(Route.bookmarks)
                        default: break
                        }
                    }
                }
                #endif
            }
        }
    }

    private var quickLinks: some View {
        GlassEffectContainer(spacing: 12) {
            VStack(spacing: 0) {
                link("Latest Episodes", icon: "clock.fill", route: .latest, detail: nil)
                Divider().overlay(.white.opacity(0.08)).padding(.leading, 56)
                link("Bookmarks", icon: "bookmark.fill", route: .bookmarks, detail: lib.value.bookmarkCount, tint: Brand.amber)
                Divider().overlay(.white.opacity(0.08)).padding(.leading, 56)
                link("Starred", icon: "star.fill", route: .starred, detail: lib.value.starredCount, tint: Brand.amber)
            }
            .glassEffect(.regular, in: .rect(cornerRadius: 26))
        }
        .padding(.horizontal, 20)
    }

    private func link(_ title: String, icon: String, route: Route, detail: Int?, tint: Color = Brand.accent) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 17, weight: .semibold)).foregroundStyle(tint).frame(width: 28)
                Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Brand.text)
                Spacer()
                if let detail, detail > 0 { Text("\(detail)").font(.system(size: 15, weight: .medium)).foregroundStyle(Brand.muted) }
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Brand.grip)
            }
            .padding(.horizontal, 16).frame(height: 54).contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private var continueShelf: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Continue listening").padding(.horizontal, 20)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(lib.value.continueListening) { item in
                        Button { Task { await ws.player.play(item.id, context: PlayContext(label: "Continue listening", ids: lib.value.continueListening.map(\.id))) } } label: {
                            HStack(spacing: 12) {
                                Artwork(url: item.podcast?.imageUrl, cornerRadius: 14).frame(width: 64, height: 64)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.episode.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Brand.text).lineLimit(2).multilineTextAlignment(.leading)
                                    Text("\(Fmt.duration(item.remainingSec)) left").font(.system(size: 12)).foregroundStyle(Brand.muted)
                                    ProgressTrack(value: item.progress)
                                }
                                .frame(width: 150, alignment: .leading)
                            }
                            .padding(12).glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
            }
        }
    }
}

struct PodcastTile: View {
    let podcast: Podcast
    let unplayed: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Artwork(url: podcast.imageUrl, cornerRadius: 22)
                .overlay(alignment: .topTrailing) {
                    if unplayed > 0 {
                        Text("\(unplayed)").font(.system(size: 12, weight: .bold).monospacedDigit()).foregroundStyle(Brand.ink)
                            .padding(.horizontal, 8).frame(minWidth: 24, minHeight: 24)
                            .glassEffect(.regular.tint(Brand.accent), in: .capsule).padding(8)
                            .accessibilityLabel("\(unplayed) unplayed")
                    }
                }
            Text(podcast.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.text).lineLimit(1)
            Text(podcast.author).font(.system(size: 12)).foregroundStyle(Brand.muted).lineLimit(1).padding(.top, -6)
        }
        .contentShape(.rect)
    }
}

// MARK: Add podcast (feed URL or OPML)

struct AddPodcastSheet: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var isPrivate = false
    @State private var busy = false
    @State private var error: String?
    @State private var importing = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://example.com/feed.xml", text: $url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
                    Toggle("Private feed (never shown in Discover)", isOn: $isPrivate).tint(Brand.accent)
                } header: { Text("Feed URL") } footer: {
                    if let error { Text(error).foregroundStyle(Brand.danger) } else { Text("Your server fetches the feed, so everything stays in sync across devices.") }
                }
                Section {
                    Button { importing = true } label: { Label("Import OPML file", systemImage: "square.and.arrow.down") }
                }
            }
            .navigationTitle("Add a Podcast").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else { Button("Add") { add() }.fontWeight(.bold).disabled(url.trimmedOrNil == nil) }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.xml, .data, .text]) { r in
                if case .success(let u) = r { importOPML(u) }
            }
            .brandScreen()
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium])
        .onAppear { focused = true }
    }

    private func add() {
        busy = true; error = nil
        Task {
            do {
                var body: [String: Any] = ["feedUrl": url.trimmingCharacters(in: .whitespacesAndNewlines)]
                if isPrivate { body["private"] = true }
                let r: AddPodcastResponse = try await ws.api.post("/podcasts", json: body)
                await ws.sync.sync()
                Toaster.shared.show("Subscribed to \(r.podcast.title)")
                dismiss()
            } catch is NetworkError { error = "You need a connection to add a podcast." }
            catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    private func importOPML(_ u: URL) {
        busy = true; error = nil
        Task {
            defer { busy = false }
            let scoped = u.startAccessingSecurityScopedResource()
            defer { if scoped { u.stopAccessingSecurityScopedResource() } }
            do {
                let text = try String(contentsOf: u, encoding: .utf8)
                let r: OPMLImportResponse = try await ws.api.postText("/opml/import", text: text, contentType: "text/x-opml")
                await ws.sync.sync()
                Toaster.shared.show("Imported \(Fmt.plural(r.imported, "podcast"))\(r.failed.isEmpty ? "" : ", \(r.failed.count) failed")")
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
