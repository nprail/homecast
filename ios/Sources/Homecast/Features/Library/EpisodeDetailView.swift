import GRDB
import SwiftUI

struct EpisodeSnapshot: Sendable {
    var item: EpisodeItem?
    var bookmarks: [Bookmark] = []
}

struct EpisodeDetailView: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    let episodeId: String
    @StateObject private var snap: Live<EpisodeSnapshot>

    init(episodeId: String) {
        self.episodeId = episodeId
        _snap = StateObject(wrappedValue: Live(EpisodeSnapshot(), in: AppEnvironment.shared.workspace?.db) { d in
            var s = EpisodeSnapshot()
            if let e = try Episode.fetchOne(d, key: episodeId) { s.item = try d.episodeItems([e]).first }
            s.bookmarks = try Bookmark.filter(Column("episodeId") == episodeId).filter(Column("deleted") == false).order(Column("positionMs")).fetchAll(d)
            return s
        })
    }

    var body: some View {
        ScrollView {
            if let item = snap.value.item {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(alignment: .top, spacing: 16) {
                        Artwork(url: item.podcast?.imageUrl, cornerRadius: 22).frame(width: 112, height: 112)
                        VStack(alignment: .leading, spacing: 6) {
                            if let p = item.podcast {
                                NavigationLink(value: Route.podcast(p.id)) { Text(p.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Brand.accent) }
                            }
                            Text(item.episode.title).font(.display(22)).foregroundStyle(Brand.text).fixedSize(horizontal: false, vertical: true)
                            Text([Fmt.released(item.episode.releasedDate), Fmt.duration(item.episode.durationSec)].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.system(size: 13)).foregroundStyle(Brand.muted)
                        }
                    }
                    actions(item)
                    if item.status == .inProgress { VStack(alignment: .leading, spacing: 6) { ProgressTrack(value: item.progress, height: 5); Text("\(Fmt.duration(item.remainingSec)) left").font(.caption).foregroundStyle(Brand.muted) } }

                    NavigationLink { TranscriptScreen(episodeId: episodeId) } label: {
                        HStack { Label("Transcript", systemImage: "quote.bubble.fill"); Spacer(); if item.episode.hasPublisherTranscript == true { Text("From publisher").font(.caption).foregroundStyle(Brand.muted) }; Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Brand.grip) }
                            .font(.system(size: 16, weight: .semibold)).foregroundStyle(Brand.text).padding(.horizontal, 16).frame(height: 52).glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
                    }
                    .buttonStyle(.plain)

                    if !snap.value.bookmarks.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionLabel("Bookmarks")
                            ForEach(snap.value.bookmarks) { b in
                                Button { Task { await playAt(item, b.positionMs) } } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "bookmark.fill").foregroundStyle(Brand.amber)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(b.title ?? "Bookmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.text)
                                            if let n = b.note { Text(n).font(.system(size: 13)).foregroundStyle(Brand.muted).lineLimit(2) }
                                        }
                                        Spacer()
                                        Text(Fmt.clock(b.positionMs)).font(.system(size: 14, weight: .semibold).monospacedDigit()).foregroundStyle(Brand.accent)
                                    }
                                    .padding(.horizontal, 14).padding(.vertical, 10).glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
                                }.buttonStyle(.plain)
                            }
                        }
                    }

                    if !item.episode.summary.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionLabel("Show notes")
                            Text(Fmt.plainText(item.episode.summary)).font(.system(size: 16)).foregroundStyle(Brand.text.opacity(0.9)).lineSpacing(3)
                        }
                    }
                }
                .padding(20)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .brandScreen()
    }

    private func playAt(_ item: EpisodeItem, _ ms: Int) async {
        await ws.player.play(item.id, context: .upNext)
        ws.player.seek(toMs: ms)
    }

    private func actions(_ item: EpisodeItem) -> some View {
        let current = ws.player.episode?.id == item.id
        return GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    Task { if current { ws.player.toggle() } else { await ws.player.play(item.id, context: .upNext) } }
                } label: {
                    Label(current && ws.player.isPlaying ? "Pause" : item.status == .inProgress ? "Resume" : "Play", systemImage: current && ws.player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(Brand.ink).frame(maxWidth: .infinity, minHeight: 30)
                }
                .buttonStyle(.glassProminent).tint(Brand.accent).controlSize(.large)
                Button { ws.data.enqueue(item.id, .last); Toaster.shared.show("Added to Up Next") } label: { Image(systemName: "text.badge.plus").frame(width: 30, height: 30) }
                    .buttonStyle(.glass).controlSize(.large).accessibilityLabel("Add to Up Next")
                downloadButton(item)
                Menu { EpisodeMenu(item: item) } label: { Image(systemName: "ellipsis").frame(width: 30, height: 30) }
                    .buttonStyle(.glass).controlSize(.large).accessibilityLabel("More")
            }
        }
    }

    @ViewBuilder private func downloadButton(_ item: EpisodeItem) -> some View {
        Button {
            if item.downloaded { ws.downloads.remove(item.id) } else if ws.downloads.active[item.id] != nil { ws.downloads.cancel(item.id) } else { ws.downloads.enqueue(item.id) }
        } label: {
            if item.downloaded { Image(systemName: "arrow.down.circle.fill").foregroundStyle(Brand.accent).frame(width: 30, height: 30) }
            else if let p = ws.downloads.active[item.id] { DownloadBadge(downloaded: false, progress: p).frame(width: 30, height: 30) }
            else { Image(systemName: "arrow.down.circle").frame(width: 30, height: 30) }
        }
        .buttonStyle(.glass).controlSize(.large).accessibilityLabel(item.downloaded ? "Remove download" : "Download")
    }
}

struct TranscriptScreen: View {
    let episodeId: String
    var body: some View {
        TranscriptView(episodeId: episodeId).navigationTitle("Transcript").navigationBarTitleDisplayMode(.inline).brandScreen()
    }
}
