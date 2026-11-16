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

    enum PlayerSheet: String, Identifiable { case speed, sleep, queue; var id: String { rawValue } }

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
                Scrubber(positionMs: player.positionMs, durationMs: player.durationMs, markers: markers, speed: player.speed) { player.seek(toMs: $0) }
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
