import SwiftUI

/// App-level UI state shared across tabs (sheets that any row can trigger).
@MainActor @Observable
final class UIState {
    var showPlayer = false
    /// Set to open the player with its transcript showing (search results use this).
    var showTranscript = false
    var playlistPickerEpisodeId: String?
    var showAddPodcast = false
    /// A screen to open on the Library tab (a tapped notification sets this).
    var pendingRoute: Route?
    var bookmarkEditor: BookmarkTarget?
    struct BookmarkTarget: Identifiable { let id = UUID(); var episodeId: String; var positionMs: Int; var existing: Bookmark? }
}

struct EpisodeRow: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    let item: EpisodeItem
    /// Ids of the list this row belongs to, so playback continues through it.
    var listIds: [String] = []
    var listLabel: String = "Up Next"
    var showPodcast = true
    var showArtwork = true

    private var isCurrent: Bool { ws.player.episode?.id == item.id }

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            if showArtwork {
                Artwork(url: item.podcast?.imageUrl, cornerRadius: 12).frame(width: 60, height: 60)
            }
            VStack(alignment: .leading, spacing: 4) {
                if showPodcast, let p = item.podcast {
                    Text(p.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(isCurrent ? Brand.accent : Brand.muted).lineLimit(1)
                }
                Text(item.episode.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(item.status == .played ? Brand.muted : Brand.text)
                    .lineLimit(2).multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    if item.status == .unplayed { Circle().fill(Brand.accent).frame(width: 7, height: 7).accessibilityLabel("Unplayed") }
                    Text(meta).font(.system(size: 13)).foregroundStyle(Brand.muted).lineLimit(1)
                    if item.starred { Image(systemName: "star.fill").font(.system(size: 11)).foregroundStyle(Brand.amber).accessibilityLabel("Starred") }
                    DownloadBadge(downloaded: item.downloaded, progress: ws.downloads.active[item.id]).font(.system(size: 12))
                }
                if item.status == .inProgress { ProgressTrack(value: item.progress).frame(maxWidth: 160).padding(.top, 2) }
            }
            Spacer(minLength: 0)
            Button {
                Haptics.tap()
                Task {
                    if isCurrent { ws.player.toggle() }
                    else if listIds.isEmpty { await ws.player.play(item.id, context: .upNext) }
                    else { await ws.player.play(item.id, in: listIds, label: listLabel) }
                }
            } label: {
                Image(systemName: isCurrent && ws.player.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Brand.accent)
                    .frame(width: 44, height: 44)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel(isCurrent && ws.player.isPlaying ? "Pause" : "Play \(item.episode.title)")
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
        .contextMenu { EpisodeMenu(item: item) }
    }

    private var meta: String {
        var parts = [Fmt.released(item.episode.releasedDate)]
        if item.status == .inProgress { parts.append("\(Fmt.duration(item.remainingSec)) left") }
        else if item.episode.durationSec > 0 { parts.append(Fmt.duration(item.episode.durationSec)) }
        if item.status == .played { parts.append("Played") }
        return parts.joined(separator: " · ")
    }
}

/// The long-press menu / actions for an episode (queue, state, star, download, playlist).
struct EpisodeMenu: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    let item: EpisodeItem

    var body: some View {
        Button { ws.data.enqueue(item.id, .next, currentId: ws.player.episode?.id); Toaster.shared.show("Playing next") } label: { Label("Play Next", systemImage: "text.insert") }
        Button { ws.data.enqueue(item.id, .last); Toaster.shared.show("Added to Up Next") } label: { Label("Add to Up Next", systemImage: "text.badge.plus") }
        Button { ui.playlistPickerEpisodeId = item.id } label: { Label("Add to Playlist…", systemImage: "music.note.list") }
        let playingThis = ws.player.episode?.id == item.id
        ShareMomentLink(episodeId: item.id, title: item.episode.title, podcast: item.podcast?.title, positionMs: playingThis ? ws.player.positionMs : nil) {
            Label(playingThis ? "Share This Moment" : "Share Episode", systemImage: "square.and.arrow.up")
        }
        Divider()
        if item.status == .played {
            Button { ws.data.markUnplayed(item.id) } label: { Label("Mark as Unplayed", systemImage: "circle") }
        } else {
            Button { ws.data.markPlayed(item.id) } label: { Label("Mark as Played", systemImage: "checkmark.circle") }
        }
        Button { ws.data.setStarred(item.id, !item.starred) } label: { Label(item.starred ? "Remove Star" : "Star", systemImage: item.starred ? "star.slash" : "star") }
        if item.downloaded {
            Button(role: .destructive) { ws.downloads.remove(item.id) } label: { Label("Remove Download", systemImage: "trash") }
        } else if ws.downloads.active[item.id] != nil {
            Button { ws.downloads.cancel(item.id) } label: { Label("Cancel Download", systemImage: "xmark.circle") }
        } else {
            Button { ws.downloads.enqueue(item.id) } label: { Label("Download", systemImage: "arrow.down.circle") }
        }
    }
}

/// Swipe actions shared by episode lists.
struct EpisodeSwipe: ViewModifier {
    @Environment(Workspace.self) private var ws
    let item: EpisodeItem
    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button { ws.data.enqueue(item.id, .next, currentId: ws.player.episode?.id); Toaster.shared.show("Playing next") } label: { Label("Play Next", systemImage: "text.insert") }.tint(Brand.accent)
            }
            .swipeActions(edge: .trailing) {
                Button { ws.data.enqueue(item.id, .last); Toaster.shared.show("Added to Up Next") } label: { Label("Up Next", systemImage: "text.badge.plus") }.tint(Brand.amber)
                if item.status == .played {
                    Button { ws.data.markUnplayed(item.id) } label: { Label("Unplayed", systemImage: "circle") }.tint(.gray)
                } else {
                    Button { ws.data.markPlayed(item.id) } label: { Label("Played", systemImage: "checkmark") }.tint(.gray)
                }
            }
    }
}
extension View { func episodeSwipe(_ item: EpisodeItem) -> some View { modifier(EpisodeSwipe(item: item)) } }
