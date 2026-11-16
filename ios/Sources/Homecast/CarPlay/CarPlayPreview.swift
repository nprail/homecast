#if DEBUG
import GRDB
import SwiftUI

/// DEBUG-only layout preview of the CarPlay screens, rendered with SwiftUI from the same database queries the real
/// CarPlay templates use. This is NOT Apple's CarPlay renderer (Xcode 27's CarPlay Simulator needs a physical iPhone
/// and an Apple-approved entitlement): it exists to review content, hierarchy and brand fit. Launch with HC_CARPLAY_PREVIEW=1.
struct CarPlayPreviewScreen: View {
    enum Page { case upNext, podcasts, nowPlaying }
    let page: Page
    let items: [EpisodeItem]
    let podcasts: [Podcast]
    let now: (episode: Episode, podcast: Podcast?, speed: Double, positionMs: Int, durationMs: Int)?

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Group {
                switch page {
                case .upNext: list(title: "Up Next", rows: items.prefix(5).map { ($0.episode.title, "\($0.podcast?.title ?? "") · \(Fmt.released($0.episode.releasedDate)) · \($0.status == .inProgress ? "\(Fmt.duration($0.remainingSec)) left" : Fmt.duration($0.episode.durationSec))", $0.podcast?.imageUrl, $0.id == now?.episode.id) })
                case .podcasts: list(title: "Podcasts", rows: podcasts.prefix(5).map { ($0.title, $0.author, $0.imageUrl, false) })
                case .nowPlaying: nowPlaying
                }
            }
        }
        .frame(width: 1280, height: 720)
        .background(Color(hex: 0x0B0D11))
        .environment(\.colorScheme, .dark)
    }

    private var sidebar: some View {
        VStack(spacing: 22) {
            ForEach([("text.line.first.and.arrowtriangle.forward", "Up Next", Page.upNext), ("music.note.list", "Playlists", nil), ("square.grid.2x2.fill", "Podcasts", Page.podcasts), ("arrow.down.circle.fill", "Downloads", nil)], id: \.1) { icon, label, p in
                VStack(spacing: 6) {
                    Image(systemName: icon).font(.system(size: 30))
                    Text(label).font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(p == page || (p == .upNext && page == .nowPlaying) ? Brand.accent : Color.white.opacity(0.7))
                .frame(width: 124, height: 100)
                .background((p == page) ? Color.white.opacity(0.12) : .clear, in: .rect(cornerRadius: 20))
            }
            Spacer()
            Image(systemName: "waveform").font(.system(size: 30)).foregroundStyle(page == .nowPlaying ? Brand.accent : .white.opacity(0.7))
            Text("Now Playing").font(.system(size: 13, weight: .semibold)).foregroundStyle(page == .nowPlaying ? Brand.accent : .white.opacity(0.7))
        }
        .padding(.vertical, 28).frame(width: 150).background(Color(hex: 0x14171C))
    }

    private func list(title: String, rows: [(String, String, String?, Bool)]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.display(34)).padding(.horizontal, 36).padding(.top, 28).padding(.bottom, 16)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                HStack(spacing: 22) {
                    Artwork(url: r.2, cornerRadius: 12).frame(width: 84, height: 84)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.0).font(.system(size: 26, weight: .semibold)).foregroundStyle(r.3 ? Brand.accent : .white).lineLimit(1)
                        Text(r.1).font(.system(size: 20)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                    }
                    Spacer()
                    if r.3 { Image(systemName: "waveform").font(.system(size: 28)).foregroundStyle(Brand.accent) }
                }
                .padding(.horizontal, 36).frame(height: 108)
                Divider().overlay(.white.opacity(0.08)).padding(.leading, 142)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var nowPlaying: some View {
        HStack(spacing: 48) {
            Artwork(url: now?.podcast?.imageUrl, cornerRadius: 28).frame(width: 400, height: 400).shadow(color: .black.opacity(0.5), radius: 24, y: 12)
            VStack(alignment: .leading, spacing: 14) {
                Text(now?.episode.title ?? "").font(.display(34)).lineLimit(2)
                Text(now?.podcast?.title ?? "").font(.system(size: 24, weight: .semibold)).foregroundStyle(Brand.accent)
                VStack(spacing: 8) {
                    ProgressTrack(value: Double(now?.positionMs ?? 0) / Double(max(1, now?.durationMs ?? 1)), height: 8)
                    HStack { Text(Fmt.clock(now?.positionMs ?? 0)); Spacer(); Text("-" + Fmt.clock((now?.durationMs ?? 0) - (now?.positionMs ?? 0))) }.font(.system(size: 18).monospacedDigit()).foregroundStyle(.white.opacity(0.6))
                }.padding(.top, 8)
                HStack(spacing: 28) {
                    ForEach(["gobackward.15", "pause.fill", "goforward.30"], id: \.self) { s in
                        Image(systemName: s).font(.system(size: s == "pause.fill" ? 40 : 32, weight: .bold)).foregroundStyle(s == "pause.fill" ? Brand.ink : .white)
                            .frame(width: s == "pause.fill" ? 110 : 84, height: s == "pause.fill" ? 110 : 84)
                            .background(s == "pause.fill" ? Brand.accent : Color.white.opacity(0.12), in: .circle)
                    }
                }.padding(.top, 10)
                HStack(spacing: 18) {
                    Text(Fmt.speed(now?.speed ?? 1)).font(.display(26)).foregroundStyle(Brand.amber).frame(width: 110, height: 70).background(Color.white.opacity(0.12), in: .rect(cornerRadius: 18))
                    Image(systemName: "bookmark.fill").font(.system(size: 28)).foregroundStyle(Brand.amber).frame(width: 110, height: 70).background(Color.white.opacity(0.12), in: .rect(cornerRadius: 18))
                    Image(systemName: "list.bullet").font(.system(size: 28)).frame(width: 110, height: 70).background(Color.white.opacity(0.12), in: .rect(cornerRadius: 18))
                }.padding(.top, 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 40)
        }
        .padding(.leading, 48).frame(maxWidth: .infinity)
    }
}

@MainActor
enum CarPlayPreviewRenderer {
    static func run(ws: Workspace) async {
        try? await Task.sleep(for: .seconds(9)) // let sync + artwork settle
        let uid = ws.user.id
        let items = (try? await ws.db.pool.read { d -> [EpisodeItem] in
            let ids = try Playlist.fetchOne(d, key: RecordID.upNext(userId: uid)).map { $0.episodeIds } ?? []
            return try d.orderedEpisodeItems(ids: ids)
        }) ?? []
        let podcasts = (try? await ws.db.pool.read { d in try Podcast.filter(keys: try d.subscribedPodcastIds()).order(sql: "title COLLATE NOCASE").fetchAll(d) }) ?? []
        let p = ws.player
        let now = p.episode.map { (episode: $0, podcast: p.podcast, speed: p.speed, positionMs: p.positionMs, durationMs: p.durationMs) }
        for (name, page) in [("carplay-upnext", CarPlayPreviewScreen.Page.upNext), ("carplay-podcasts", .podcasts), ("carplay-nowplaying", .nowPlaying)] {
            let r = ImageRenderer(content: CarPlayPreviewScreen(page: page, items: items, podcasts: podcasts, now: now))
            r.scale = 1
            if let data = r.uiImage?.pngData() {
                let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("\(name).png")
                try? data.write(to: url)
                print("CARPLAY_PREVIEW \(url.path)")
            }
        }
    }
}
#endif
