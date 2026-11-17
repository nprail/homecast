import GRDB
import SwiftUI

struct PodcastSnapshot: Sendable {
    var podcast: Podcast?
    var subscription: Subscription?
    var items: [EpisodeItem] = []
    var settings = UserSettings(id: "")
}

struct PodcastView: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    let podcastId: String
    @StateObject private var snap: Live<PodcastSnapshot>
    @State private var filter: Filter = .all
    @State private var newestFirst = true
    @State private var expanded = false
    @State private var confirmUnsubscribe = false

    enum Filter: String, CaseIterable, Identifiable { case all = "All", unplayed = "Unplayed", downloaded = "Downloaded"; var id: String { rawValue } }

    init(podcastId: String) {
        self.podcastId = podcastId
        let env = AppEnvironment.shared
        let uid = env.workspace?.user.id ?? ""
        _snap = StateObject(wrappedValue: Live(PodcastSnapshot(), in: env.workspace?.db) { d in
            var s = PodcastSnapshot()
            s.podcast = try Podcast.fetchOne(d, key: podcastId)
            s.subscription = try Subscription.filter(Column("podcastId") == podcastId).filter(Column("deleted") == false).fetchOne(d)
            s.items = try d.episodeItems(try Episode.filter(Column("podcastId") == podcastId).order(Column("releasedAt").desc).fetchAll(d))
            s.settings = try d.settings(userId: uid)
            return s
        })
    }

    private var visible: [EpisodeItem] {
        var items = snap.value.items
        switch filter {
        case .all: break
        case .unplayed: items = items.filter { $0.status != .played }
        case .downloaded: items = items.filter(\.downloaded)
        }
        return newestFirst ? items : items.reversed()
    }

    var body: some View {
        let s = snap.value
        List {
            if let p = s.podcast {
                header(p, s).listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(.init(top: 6, leading: 20, bottom: 10, trailing: 20))
            }
            Section {
                ForEach(visible) { item in
                    NavigationLink(value: Route.episode(item.id)) {
                        EpisodeRow(item: item, listIds: visible.map(\.id), listLabel: s.podcast?.title ?? "Podcast", showPodcast: false, showArtwork: false)
                    }
                    .listRowBackground(Color.clear)
                    .episodeSwipe(item)
                }
            } header: {
                Picker("Filter", selection: $filter) { ForEach(Filter.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented).textCase(nil).padding(.bottom, 4)
            }
            if visible.isEmpty {
                Text(filter == .all ? "No episodes yet." : "Nothing matches this filter.").foregroundStyle(Brand.muted).frame(maxWidth: .infinity).listRowBackground(Color.clear).padding(.vertical, 20)
            }
        }
        .listStyle(.plain)
        .navigationTitle(s.podcast?.title ?? "Podcast").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { menu(s) } }
        .refreshable { await ws.sync.sync() }
        .brandScreen()
        .confirmationDialog("Unsubscribe from \(s.podcast?.title ?? "this podcast")?", isPresented: $confirmUnsubscribe, titleVisibility: .visible) {
            Button("Unsubscribe", role: .destructive) { ws.data.unsubscribe(podcastId); dismiss() }
        } message: { Text("Downloaded episodes stay until you remove them.") }
    }

    private func header(_ p: Podcast, _ s: PodcastSnapshot) -> some View {
        VStack(spacing: 14) {
            Artwork(url: p.imageUrl, cornerRadius: 28).frame(width: 168, height: 168).shadow(color: Brand.accent.opacity(0.25), radius: 24, y: 10)
            VStack(spacing: 4) {
                Text(p.title).font(.display(24)).multilineTextAlignment(.center).foregroundStyle(Brand.text)
                Text(p.author).font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.accent)
            }
            if !p.summary.isEmpty {
                Text(Fmt.plainText(p.summary)).font(.system(size: 14)).foregroundStyle(Brand.muted).lineLimit(expanded ? nil : 3).multilineTextAlignment(.center)
                    .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
            }
            HStack(spacing: 10) {
                if let latest = s.items.first(where: { $0.status != .played }) ?? s.items.first {
                    Button { Task { await ws.player.play(latest.id, in: visible.map(\.id), label: p.title) } } label: {
                        Label(latest.status == .inProgress ? "Resume" : "Play Latest", systemImage: "play.fill").font(.system(size: 16, weight: .semibold)).foregroundStyle(Brand.ink).frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .buttonStyle(.glassProminent).tint(Brand.accent).controlSize(.large)
                }
                if s.subscription == nil {
                    Button { subscribe() } label: { Label("Subscribe", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 28) }
                        .buttonStyle(.glass).controlSize(.large)
                }
            }
            if let sp = s.settings.podcastSpeeds[p.id] {
                Label("Plays at \(Fmt.speed(sp))", systemImage: "gauge.with.dots.needle.67percent").font(.system(size: 12, weight: .semibold)).foregroundStyle(Brand.amber)
            }
        }
    }

    private func subscribe() {
        ws.data.ensureSubscriptionLocal(podcastId)
        ws.sync.schedule(after: 0.2)
        Toaster.shared.show("Subscribed")
    }

    private func menu(_ s: PodcastSnapshot) -> some View {
        Menu {
            Picker("Order", selection: $newestFirst) {
                Label("Newest first", systemImage: "arrow.down").tag(true)
                Label("Oldest first", systemImage: "arrow.up").tag(false)
            }
            if let sub = s.subscription {
                Button { ws.data.setNotify(podcastId, !sub.newEpisodeNotify) } label: { Label(sub.newEpisodeNotify ? "Turn Off Notifications" : "Turn On Notifications", systemImage: sub.newEpisodeNotify ? "bell.slash" : "bell") }
                Menu("Auto-download", systemImage: "arrow.down.circle") {
                    let current = sub.autoDownload
                    Button { ws.data.setAutoDownload(podcastId, .init(mode: .off)) } label: { check("Off", current.mode == .off) }
                    ForEach([1, 3, 5], id: \.self) { n in
                        Button { ws.data.setAutoDownload(podcastId, .init(mode: .latest, count: n)) } label: { check("Latest \(n)", current.mode == .latest && (current.count ?? 3) == n) }
                    }
                    Button { ws.data.setAutoDownload(podcastId, .init(mode: .all)) } label: { check("All new episodes", current.mode == .all) }
                }
                Menu("Delete played after", systemImage: "trash.slash") {
                    let cur = s.settings.cleanupDays[podcastId]
                    Button { ws.data.setCleanupDays(podcastId, nil) } label: { check("Never", cur == nil) }
                    ForEach([1, 3, 7, 14, 30], id: \.self) { d in Button { ws.data.setCleanupDays(podcastId, d) } label: { check(Fmt.plural(d, "day"), cur == d) } }
                }
            }
            Menu("Playback speed", systemImage: "gauge.with.dots.needle.67percent") {
                let cur = s.settings.podcastSpeeds[podcastId]
                Button { ws.data.setPodcastSpeed(podcastId, nil); ws.player.refreshSpeed() } label: { check("Default (\(Fmt.speed(s.settings.defaultSpeed)))", cur == nil) }
                ForEach([1.0, 1.2, 1.5, 1.8, 2.0], id: \.self) { v in
                    Button { ws.data.setPodcastSpeed(podcastId, v); ws.player.refreshSpeed() } label: { check(Fmt.speed(v), cur == v) }
                }
            }
            if s.subscription != nil {
                Divider()
                Button(role: .destructive) { confirmUnsubscribe = true } label: { Label("Unsubscribe", systemImage: "minus.circle") }
            }
        } label: { Image(systemName: "ellipsis") }
        .accessibilityLabel("Podcast options")
    }

    @ViewBuilder private func check(_ text: String, _ on: Bool) -> some View {
        if on { Label(text, systemImage: "checkmark") } else { Text(text) }
    }
}
