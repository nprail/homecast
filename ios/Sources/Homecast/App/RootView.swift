import GRDB
import SwiftUI

struct RootView: View {
    @State private var env = AppEnvironment.shared

    var body: some View {
        Group {
            switch env.state {
            case .launching:
                ZStack { BrandBackdrop(); HomecastLogo(size: 84) }
            case .signedOut:
                AuthView()
            case .signedIn:
                if let ws = env.workspace {
                    MainTabs()
                        .environment(ws)
                        .id(ws.user.id)
                }
            }
        }
        .animation(.smooth, value: env.state)
        .toastHost()
    }
}

enum AppTab: Hashable { case library, upNext, discover, downloads, settings }

struct MainTabs: View {
    @Environment(Workspace.self) private var ws
    @State private var ui = UIState()
    @State private var tab: AppTab = {
        if let t = ProcessInfo.processInfo.environment["HC_TAB"] { return ["upnext": .upNext, "discover": .discover, "downloads": .downloads, "settings": .settings][t] ?? .library }
        return .library
    }()

    var body: some View {
        TabView(selection: $tab) {
            Tab("Library", systemImage: "books.vertical.fill", value: AppTab.library) { LibraryView() }
            Tab("Up Next", systemImage: "text.line.first.and.arrowtriangle.forward", value: AppTab.upNext) { QueueView() }
            Tab("Discover", systemImage: "sparkle.magnifyingglass", value: AppTab.discover) { DiscoverView() }
            Tab("Downloads", systemImage: "arrow.down.circle.fill", value: AppTab.downloads) { DownloadsView() }
            Tab("Settings", systemImage: "gearshape.fill", value: AppTab.settings) { SettingsView() }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .miniPlayerAccessory(enabled: ws.player.hasEpisode)
        .environment(ui)
        .tint(Brand.accent)
        .sheet(isPresented: $ui.showPlayer) {
            NowPlayingView().environment(ws).environment(ui).presentationBackground(Brand.bg)
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $ui.showAddPodcast) { AddPodcastSheet().environment(ws) }
        .sheet(item: $ui.bookmarkEditor) { BookmarkSheet(target: $0).environment(ws) }
        .sheet(item: Binding(get: { ui.playlistPickerEpisodeId.map(IDBox.init) }, set: { ui.playlistPickerEpisodeId = $0?.id })) { PlaylistPickerSheet(episodeId: $0.id).environment(ws) }
        .onAppear { debugHooks() }
    }
}

struct IDBox: Identifiable { let id: String }

extension MainTabs {
    /// Debug-only launch hooks used to drive screenshots (HC_PLAY, HC_OPEN_PLAYER, HC_TAB, HC_SEGMENT, HC_ROUTE).
    func debugHooks() {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if env["HC_CARPLAY_PREVIEW"] != nil { Task { await CarPlayPreviewRenderer.run(ws: ws) } }
        guard env["HC_PLAY"] != nil || env["HC_OPEN_PLAYER"] != nil || env["HC_DOWNLOAD"] != nil else { return }
        Task {
            try? await Task.sleep(for: .seconds(3))
            let ids = (try? await ws.db.pool.read { try Episode.order(Column("releasedAt").desc).limit(4).fetchAll($0).map(\.id) }) ?? []
            let first = (try? await ws.db.pool.read { try Episode.filter(Column("guid") == "signal-0").fetchOne($0)?.id }) ?? ids.first
            ids.dropFirst().forEach { ws.data.enqueue($0, .last) }
            if let first, env["HC_PLAY"] != nil {
                await ws.player.play(first, context: .upNext)
                ws.player.seek(toMs: 47_000)
                if let sp = env["HC_SPEED"], let v = Double(sp) { ws.player.setSpeed(v, scope: .podcast) }
                ws.data.addBookmark(episodeId: first, positionMs: 21_000, title: "Router post office", note: "Great analogy for queues")
            }
            if env["HC_DOWNLOAD"] != nil { ids.prefix(2).forEach { ws.downloads.enqueue($0) } }
            if env["HC_OPEN_PLAYER"] != nil { try? await Task.sleep(for: .seconds(1)); ui.showPlayer = true }
        }
        #endif
    }
}
