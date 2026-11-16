import GRDB
import SwiftUI

struct DownloadsSnapshot: Sendable {
    var items: [EpisodeItem] = []
    var bytes = 0
    var pending: [EpisodeItem] = []
}

struct DownloadsView: View {
    @Environment(Workspace.self) private var ws
    @StateObject private var snap: Live<DownloadsSnapshot>
    @State private var wifiOnly = DeviceSettings.wifiOnly
    @State private var confirmClear = false

    init() {
        _snap = StateObject(wrappedValue: Live(DownloadsSnapshot(), in: AppEnvironment.shared.workspace?.db) { d in
            let rows = try Download.order(Column("at").desc).fetchAll(d)
            var s = DownloadsSnapshot()
            s.bytes = rows.reduce(0) { $0 + $1.bytes }
            s.items = try d.orderedEpisodeItems(ids: rows.map(\.episodeId))
            return s
        })
    }

    var body: some View {
        let s = snap.value
        let activeIds = Array(ws.downloads.active.keys).sorted()
        NavigationStack {
            List {
                Section {
                    storageCard(s)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(.init(top: 4, leading: 20, bottom: 8, trailing: 20))
                }
                if !activeIds.isEmpty {
                    Section("In progress") {
                        ForEach(activeIds, id: \.self) { id in ActiveDownloadRow(episodeId: id).listRowBackground(Color.clear) }
                    }
                }
                Section(s.items.isEmpty ? "" : "On this device") {
                    ForEach(s.items) { item in
                        NavigationLink(value: Route.episode(item.id)) { EpisodeRow(item: item, listIds: s.items.map(\.id), listLabel: "Downloads") }
                            .listRowBackground(Color.clear).episodeSwipe(item)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) { ws.downloads.remove(item.id) } label: { Label("Remove", systemImage: "trash") }
                            }
                    }
                }
            }
            .listStyle(.plain)
            .overlay { if s.items.isEmpty && activeIds.isEmpty { EmptyState(icon: "arrow.down.circle", title: "Nothing downloaded", message: "Download episodes to listen offline. You can also set up auto-download for any podcast.") } }
            .navigationTitle("Downloads")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { confirmClear = true } label: { Image(systemName: "trash") }.disabled(s.items.isEmpty).accessibilityLabel("Remove all downloads")
                }
            }
            .confirmationDialog("Remove all downloads?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Remove All", role: .destructive) { ws.downloads.removeAll() }
            }
            .brandScreen()
            .routes()
        }
    }

    private func storageCard(_ s: DownloadsSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(Fmt.bytes(s.bytes)).font(.display(30)).foregroundStyle(Brand.text)
                Text("on this device").font(.system(size: 14)).foregroundStyle(Brand.muted)
                Spacer()
                Text(Fmt.plural(s.items.count, "episode")).font(.system(size: 13, weight: .semibold)).foregroundStyle(Brand.accent)
            }
            let cap = DeviceSettings.storageCapMB
            if cap > 0 { ProgressTrack(value: Double(s.bytes) / Double(cap * 1_000_000), height: 5); Text("Cap \(cap >= 1000 ? "\(cap / 1000) GB" : "\(cap) MB")").font(.caption).foregroundStyle(Brand.muted) }
            Toggle(isOn: $wifiOnly) { Label("Wi-Fi only", systemImage: "wifi").font(.system(size: 15, weight: .semibold)) }
                .tint(Brand.accent).onChange(of: wifiOnly) { _, v in DeviceSettings.wifiOnly = v }
        }
        .padding(18).glassEffect(.regular, in: .rect(cornerRadius: 26))
    }
}

private struct ActiveDownloadRow: View {
    @Environment(Workspace.self) private var ws
    let episodeId: String
    @State private var title = ""
    var body: some View {
        HStack(spacing: 12) {
            DownloadBadge(downloaded: false, progress: ws.downloads.active[episodeId]).font(.system(size: 14))
            Text(title.isEmpty ? "Episode" : title).font(.system(size: 15, weight: .medium)).foregroundStyle(Brand.text).lineLimit(1)
            Spacer()
            if let p = ws.downloads.active[episodeId], p >= 0 { Text("\(Int(p * 100))%").font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(Brand.muted) }
            Button { ws.downloads.cancel(episodeId) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Brand.muted) }.buttonStyle(.plain).accessibilityLabel("Cancel download")
        }
        .task { title = (try? ws.db.pool.read { try Episode.fetchOne($0, key: episodeId)?.title }) ?? "" }
    }
}
