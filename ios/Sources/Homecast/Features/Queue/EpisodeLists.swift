import GRDB
import SwiftUI

/// Flat episode lists: Latest (all subscribed podcasts, newest first) and Starred.
struct EpisodeListScreen: View {
    enum Kind { case latest, starred }
    let kind: Kind
    @StateObject private var items: Live<[EpisodeItem]>

    init(kind: Kind) {
        self.kind = kind
        _items = StateObject(wrappedValue: Live([], in: AppEnvironment.shared.workspace?.db) { d in
            switch kind {
            case .latest:
                let subs = try d.subscribedPodcastIds()
                return try d.episodeItems(try Episode.filter(subs.contains(Column("podcastId"))).order(Column("releasedAt").desc).limit(100).fetchAll(d))
            case .starred:
                let ids = try EpisodeState.filter(Column("starred") == true).filter(Column("deleted") == false).fetchAll(d).map(\.episodeId)
                return try d.episodeItems(try Episode.filter(keys: ids).order(Column("releasedAt").desc).fetchAll(d))
            }
        })
    }

    var body: some View {
        let label = kind == .latest ? "Latest Episodes" : "Starred"
        List {
            ForEach(items.value) { item in
                NavigationLink(value: Route.episode(item.id)) { EpisodeRow(item: item, listIds: items.value.map(\.id), listLabel: label) }
                    .listRowBackground(Color.clear).episodeSwipe(item)
            }
        }
        .listStyle(.plain)
        .overlay { if items.value.isEmpty { EmptyState(icon: kind == .latest ? "clock" : "star", title: kind == .latest ? "No episodes yet" : "No starred episodes", message: kind == .latest ? "New episodes from your podcasts appear here." : "Star an episode from its menu to keep it handy.") } }
        .navigationTitle(label).navigationBarTitleDisplayMode(.inline)
        .brandScreen()
    }
}

// MARK: Bookmarks (spec §3.2)

struct BookmarkRowData: Identifiable, Hashable, Sendable { var bookmark: Bookmark; var episode: Episode?; var podcast: Podcast?; var preview: String?; var id: String { bookmark.id } }

struct BookmarksView: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    @StateObject private var rows: Live<[BookmarkRowData]>

    init() {
        _rows = StateObject(wrappedValue: Live([], in: AppEnvironment.shared.workspace?.db) { d in
            let bms = try Bookmark.filter(Column("deleted") == false).order(Column("createdAt").desc).fetchAll(d)
            let eps = Dictionary(uniqueKeysWithValues: try Episode.filter(keys: Set(bms.map(\.episodeId))).fetchAll(d).map { ($0.id, $0) })
            let pods = Dictionary(uniqueKeysWithValues: try Podcast.filter(keys: Set(eps.values.map(\.podcastId))).fetchAll(d).map { ($0.id, $0) })
            return try bms.map { b in
                let t = try Transcript.fetchOne(d, key: b.episodeId)
                let prev = t.flatMap { tr in (tr.segments.last { $0.startMs <= b.positionMs } ?? tr.segments.first)?.text }
                return BookmarkRowData(bookmark: b, episode: eps[b.episodeId], podcast: eps[b.episodeId].flatMap { pods[$0.podcastId] }, preview: prev)
            }
        })
    }

    var body: some View {
        List {
            ForEach(rows.value) { r in
                Button {
                    Task { await ws.player.play(r.bookmark.episodeId, context: .upNext); ws.player.seek(toMs: r.bookmark.positionMs); ui.showPlayer = true }
                } label: {
                    HStack(spacing: 14) {
                        Artwork(url: r.podcast?.imageUrl, cornerRadius: 12).frame(width: 52, height: 52)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(r.bookmark.title ?? "Bookmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(Brand.text)
                            Text(r.episode?.title ?? "Episode").font(.system(size: 13)).foregroundStyle(Brand.muted).lineLimit(1)
                            if let note = r.bookmark.note { Text(note).font(.system(size: 13)).foregroundStyle(Brand.text.opacity(0.8)).lineLimit(2) }
                            if let p = r.preview { Text("“\(p)”").font(.system(size: 12)).italic().foregroundStyle(Brand.muted).lineLimit(2) }
                        }
                        Spacer(minLength: 8)
                        Text(Fmt.clock(r.bookmark.positionMs)).font(.system(size: 14, weight: .bold).monospacedDigit()).foregroundStyle(Brand.amber)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { ws.data.deleteBookmark(r.id) } label: { Label("Delete", systemImage: "trash") }
                    Button { ui.bookmarkEditor = .init(episodeId: r.bookmark.episodeId, positionMs: r.bookmark.positionMs, existing: r.bookmark) } label: { Label("Edit", systemImage: "pencil") }.tint(Brand.accent)
                }
            }
        }
        .listStyle(.plain)
        .overlay { if rows.value.isEmpty { EmptyState(icon: "bookmark", title: "No bookmarks", message: "Tap the bookmark button in the player to save a moment. Tap one here to jump straight to it.") } }
        .navigationTitle("Bookmarks").navigationBarTitleDisplayMode(.inline)
        .brandScreen()
    }
}
