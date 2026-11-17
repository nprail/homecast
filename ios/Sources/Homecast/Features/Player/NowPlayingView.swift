import GRDB
import SwiftUI

/// The full-screen player. A blurred copy of the cover tints the backdrop; every control floats on Liquid Glass.
struct NowPlayingView: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    @Environment(\.dismiss) private var dismiss
    @State private var sheet: PlayerSheet?
    @State private var showTranscript = false
    @State private var markers: [Int] = []
    @State private var chapters: [Chapter] = []

    enum PlayerSheet: String, Identifiable { case speed, sleep, queue, chapters; var id: String { rawValue } }

    var body: some View {
        let player = ws.player
        ZStack {
            VStack(spacing: 0) {
                header(player)
                if showTranscript, let ep = player.episode {
                    TranscriptView(episodeId: ep.id, embedded: true)
                        .transition(.opacity)
                } else {
                    Spacer(minLength: 8)
                    Artwork(url: player.podcast?.imageUrl, cornerRadius: 30)
                        .frame(maxWidth: 340)
                        .padding(.horizontal, 34)
                        .shadow(color: .black.opacity(0.5), radius: 30, y: 18)
                        .scaleEffect(player.isPlaying ? 1 : 0.88)
                        .animation(.spring(response: 0.5, dampingFraction: 0.72), value: player.isPlaying)
                    Spacer(minLength: 12)
                }
                titleBlock(player)
                Scrubber(positionMs: player.positionMs, durationMs: player.durationMs, markers: markers, chapters: chapters.map(\.startMs), speed: player.speed) { player.seek(toMs: $0) }
                    .padding(.horizontal, 28).padding(.top, 14)
                transport(player)
                    .padding(.top, 10)
                if player.isFading { sleepBanner(player) }
                actions(player)
                    .padding(.top, 14).padding(.bottom, 10)
            }
        }
        .background {
            ZStack {
                BrandBackdrop()
                if let url = player.podcast?.imageUrl {
                    GeometryReader { g in
                        Artwork(url: url, cornerRadius: 0).frame(width: g.size.width, height: g.size.width).blur(radius: 90).opacity(0.5)
                    }
                    .allowsHitTesting(false)
                    Brand.bg.opacity(0.35).ignoresSafeArea()
                }
            }
            .ignoresSafeArea()
            .clipped()
        }
        .preferredColorScheme(.dark)
        .task(id: player.episode?.id) { await loadMarkers() }
        .task(id: player.episode?.id) {
            chapters = []
            if let id = player.episode?.id { chapters = await ws.loadChapters(id) }
        }
        .onAppear { if ui.showTranscript { showTranscript = true; ui.showTranscript = false } }
        .onChange(of: ui.showTranscript) { _, on in if on { showTranscript = true; ui.showTranscript = false } }
        .onAppear {
            #if DEBUG
            let e = ProcessInfo.processInfo.environment
            if e["HC_TRANSCRIPT"] != nil { showTranscript = true }
            if let s = e["HC_SHEET"] { sheet = PlayerSheet(rawValue: s) }
            #endif
        }
        .sheet(item: $sheet) { s in
            switch s {
            case .speed: SpeedSheet().presentationDetents([.height(430)])
            case .sleep: SleepSheet().presentationDetents([.height(560), .large])
            case .queue: QueueSheet().presentationDetents([.medium, .large])
            case .chapters: ChaptersSheet(chapters: chapters).presentationDetents([.medium, .large])
            }
        }
    }

    // MARK: pieces

    private func header(_ player: Player) -> some View {
        ZStack {
            VStack(spacing: 2) {
                Text("PLAYING FROM").font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(Brand.muted)
                Text(player.context.label).font(.system(size: 14, weight: .semibold)).foregroundStyle(Brand.text).lineLimit(1)
            }
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.down").font(.system(size: 16, weight: .bold)).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).glassEffect(.regular.interactive(), in: .circle).accessibilityLabel("Close player")
                Spacer()
                if let ep = player.episode {
                    Menu {
                        if let item = try? ws.db.pool.read({ try $0.episodeItems([ep]).first }) { EpisodeMenu(item: item) }
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 16, weight: .bold)).frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain).glassEffect(.regular.interactive(), in: .circle).accessibilityLabel("More")
                }
            }
        }
        .padding(.horizontal, 20).padding(.top, 14)
    }

    private func titleBlock(_ player: Player) -> some View {
        VStack(spacing: 4) {
            Text(player.episode?.title ?? "Nothing playing")
                .font(.display(23)).foregroundStyle(Brand.text).multilineTextAlignment(.center).lineLimit(2)
            Text(player.podcast?.title ?? "")
                .font(.system(size: 16, weight: .semibold)).foregroundStyle(Brand.accent).lineLimit(1)
            if let c = Chapter.current(in: chapters, at: player.positionMs) {
                Text(c.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Brand.text.opacity(0.85)).lineLimit(1).transition(.opacity)
            }
            if let e = player.error { Text(e).font(.footnote).foregroundStyle(Brand.danger).padding(.top, 2) }
            else if player.playingOffline { Label("Playing downloaded file", systemImage: "arrow.down.circle.fill").font(.caption).foregroundStyle(Brand.muted).labelStyle(.titleAndIcon) }
        }
        .padding(.horizontal, 28)
    }

    private func transport(_ player: Player) -> some View {
        GlassEffectContainer(spacing: 20) {
            HStack(spacing: 18) {
                Button { player.back(); Haptics.tap() } label: {
                    Image(systemName: "gobackward.15").font(.system(size: 26, weight: .regular)).frame(width: 64, height: 64)
                }
                .buttonStyle(.plain).glassEffect(.regular.interactive(), in: .circle).accessibilityLabel("Back 15 seconds")

                Button { player.toggle(); Haptics.tap() } label: {
                    ZStack {
                        if player.isBuffering && !player.isPlaying { ProgressView().tint(Brand.ink).controlSize(.large) }
                        else { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 34, weight: .bold)).foregroundStyle(Brand.ink) }
                    }
                    .frame(width: 92, height: 92)
                }
                .buttonStyle(.plain).glassEffect(.regular.tint(Brand.accent).interactive(), in: .circle)
                .accessibilityLabel(player.isPlaying ? "Pause" : "Play")

                Button { player.forward(); Haptics.tap() } label: {
                    Image(systemName: "goforward.30").font(.system(size: 26, weight: .regular)).frame(width: 64, height: 64)
                }
                .buttonStyle(.plain).glassEffect(.regular.interactive(), in: .circle).accessibilityLabel("Forward 30 seconds")
            }
        }
        .foregroundStyle(Brand.text)
    }

    private func sleepBanner(_ player: Player) -> some View {
        Button { player.extendSleep() } label: {
            Label("Sleep timer ending. Tap or shake to add 5 min", systemImage: "moon.zzz.fill").font(.system(size: 13, weight: .semibold))
                .padding(.horizontal, 16).padding(.vertical, 10)
        }
        .buttonStyle(.plain).glassEffect(.regular.tint(Brand.amber.opacity(0.35)).interactive(), in: .capsule)
        .foregroundStyle(Brand.amber).padding(.top, 10)
    }

    private func actions(_ player: Player) -> some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                Button { sheet = .speed } label: {
                    Text(Fmt.speed(player.speed)).font(.display(17)).foregroundStyle(player.speedIsOverride ? Brand.amber : Brand.accent)
                        .frame(minWidth: 52, minHeight: 48)
                }
                .accessibilityLabel("Playback speed \(Fmt.speed(player.speed))")

                Button { sheet = .sleep } label: {
                    VStack(spacing: 1) {
                        Image(systemName: player.sleep == .off ? "moon" : "moon.fill").font(.system(size: 19))
                        if let r = player.sleepRemaining, player.sleep != .off { Text(player.sleep == .endOfEpisode ? "End" : Fmt.sleepRemaining(r)).font(.system(size: 10, weight: .bold).monospacedDigit()) }
                    }
                    .foregroundStyle(player.sleep == .off ? Brand.text : Brand.accent).frame(minWidth: 52, minHeight: 48)
                }
                .accessibilityLabel("Sleep timer")

                Button {
                    if let ep = player.episode { ui.bookmarkEditor = .init(episodeId: ep.id, positionMs: player.positionMs, existing: nil) }
                } label: {
                    Image(systemName: "bookmark.fill").font(.system(size: 19)).foregroundStyle(Brand.amber).frame(minWidth: 52, minHeight: 48)
                }
                .accessibilityLabel("Add bookmark")

                Button { withAnimation(.snappy) { showTranscript.toggle() } } label: {
                    Image(systemName: showTranscript ? "quote.bubble.fill" : "quote.bubble").font(.system(size: 19)).foregroundStyle(showTranscript ? Brand.accent : Brand.text).frame(minWidth: 52, minHeight: 48)
                }
                .accessibilityLabel("Transcript")

                if !chapters.isEmpty {
                    Button { sheet = .chapters } label: {
                        Image(systemName: "list.bullet.indent").font(.system(size: 19)).foregroundStyle(Brand.text).frame(minWidth: 52, minHeight: 48)
                    }
                    .accessibilityLabel("Chapters")
                }

                AirPlayButton().frame(width: 52, height: 48)

                Button { sheet = .queue } label: {
                    Image(systemName: "list.bullet").font(.system(size: 19)).foregroundStyle(Brand.text).frame(minWidth: 52, minHeight: 48)
                }
                .accessibilityLabel("Up Next")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 6)
            .glassEffect(.regular, in: .capsule)
        }
    }

    private func loadMarkers() async {
        guard let id = ws.player.episode?.id else { markers = []; return }
        let obs = ValueObservation.tracking { try Bookmark.filter(Column("episodeId") == id).filter(Column("deleted") == false).fetchAll($0).map(\.positionMs) }
        do { for try await v in obs.values(in: ws.db.pool) { markers = v } } catch {}
    }
}

// MARK: Chapters

extension Chapter {
    /// The chapter playing at `ms`, or nil before the first one.
    static func current(in list: [Chapter], at ms: Int) -> Chapter? { list.last { $0.startMs <= ms } }
}

private struct CachedChapters: Codable { var chapters: [Chapter]; var fetchedAt: Double }

extension Workspace {
    /// Chapters for an episode: the on-device copy while it is fresh, otherwise the server. Empty when there are none or
    /// the server can't be reached (the next play asks again).
    func loadChapters(_ episodeId: String) async -> [Chapter] {
        let key = "chapters.\(episodeId)"
        let now = Date().timeIntervalSince1970
        if let c = db.kvJSON(key, as: CachedChapters.self) {
            // Real chapter lists change rarely; an empty answer is rechecked daily in case the publisher adds them.
            let ttl: Double = c.chapters.isEmpty ? 86_400 : 7 * 86_400
            if now - c.fetchedAt < ttl { return c.chapters }
        }
        do {
            let r: ChaptersResponse = try await api.get("/episodes/\(episodeId)/chapters")
            db.setKVJSON(key, CachedChapters(chapters: r.chapters, fetchedAt: now))
            return r.chapters
        } catch let e as APIError where e.status == 404 {
            db.setKVJSON(key, CachedChapters(chapters: [], fetchedAt: now))
            return []
        } catch {
            return db.kvJSON(key, as: CachedChapters.self)?.chapters ?? []
        }
    }
}

/// Chapter list for the playing episode: the current one is highlighted, tap to jump.
struct ChaptersSheet: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    let chapters: [Chapter]

    var body: some View {
        let current = Chapter.current(in: chapters, at: ws.player.positionMs)
        VStack(spacing: 0) {
            Text("Chapters").font(.display(20)).padding(.top, 22).padding(.bottom, 8)
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(chapters, id: \.startMs) { c in
                        let on = c == current
                        Button { ws.player.seek(toMs: c.startMs); Haptics.tap(); dismiss() } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(Fmt.clock(c.startMs)).font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(on ? Brand.accent : Brand.muted).frame(width: 52, alignment: .leading)
                                Text(c.title).font(.system(size: 16, weight: on ? .semibold : .regular)).foregroundStyle(Brand.text).multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 12).contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(on ? .regular.tint(Brand.accent.opacity(0.3)) : .regular.interactive(), in: .rect(cornerRadius: 16))
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            }
        }
        .brandScreen()
    }
}
