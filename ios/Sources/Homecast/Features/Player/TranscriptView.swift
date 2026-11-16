import GRDB
import SwiftUI

/// Transcript fetching and caching (spec §3.8): cached locally for offline reading.
enum TranscriptStore {
    enum Status: Equatable {
        case loading, ready(Transcript), none, offline
        case pending(stage: String?, progress: Double?, position: Int?)
    }

    @MainActor static func load(_ ws: Workspace, episodeId: String) async -> Status {
        if let cached = try? await ws.db.pool.read({ try Transcript.fetchOne($0, key: episodeId) }) { return .ready(cached) }
        do {
            let r: TranscriptResponse = try await ws.api.get("/episodes/\(episodeId)/transcript")
            return await absorb(ws, episodeId, r)
        } catch let e as APIError where e.status == 404 { return .none }
        catch is NetworkError { return .offline }
        catch { return .none }
    }

    /// Queue generation. Any user may; requests are deduplicated per episode on the server.
    @MainActor static func request(_ ws: Workspace, episodeId: String) async -> Status {
        do {
            let r: TranscriptResponse = try await ws.api.post("/episodes/\(episodeId)/transcript")
            return await absorb(ws, episodeId, r)
        } catch is NetworkError { return .offline }
        catch { return .none }
    }

    @MainActor private static func absorb(_ ws: Workspace, _ id: String, _ r: TranscriptResponse) async -> Status {
        if r.status == "ready", let segs = r.segments {
            let t = Transcript(episodeId: id, source: r.source ?? "whisper", model: r.model, segments: segs)
            try? await ws.db.pool.write { try t.save($0) }
            return .ready(t)
        }
        return .pending(stage: r.job?.stage, progress: r.job?.progress, position: r.job?.queuePosition)
    }

    /// Transcript text near a position, shown as a preview on bookmarks.
    static func preview(db: AppDatabase, episodeId: String, atMs: Int) -> String? {
        guard let t = try? db.pool.read({ try Transcript.fetchOne($0, key: episodeId) }) else { return nil }
        let seg = t.segments.last { $0.startMs <= atMs } ?? t.segments.first
        return seg?.text
    }
}

struct TranscriptView: View {
    @Environment(Workspace.self) private var ws
    let episodeId: String
    var embedded = false
    @State private var status: TranscriptStore.Status = .loading
    @State private var query = ""

    var body: some View {
        Group {
            switch status {
            case .loading: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .offline: message("wifi.slash", "You're offline", "Transcripts you've opened are saved for offline reading. This one needs a connection.", action: ("Try again", reload))
            case .none:
                message("text.bubble", "No transcript yet", "Generate one from the audio. It's shared with everyone on this server, so each episode is only processed once.", action: ("Generate transcript", generate))
            case .pending(let stage, let progress, let pos):
                VStack(spacing: 14) {
                    ProgressView()
                    Text(stage ?? "Queued").font(.display(18))
                    if let progress { Text("\(Int(progress))%").font(.system(size: 14, weight: .semibold).monospacedDigit()).foregroundStyle(Brand.accent) }
                    if let pos, pos > 0 { Text("Position \(pos) in the queue").font(.footnote).foregroundStyle(Brand.muted) }
                    Button("Refresh", action: reload).buttonStyle(.glass)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready(let t): TranscriptLines(transcript: t, query: $query, embedded: embedded)
            }
        }
        .task(id: episodeId) { status = await TranscriptStore.load(ws, episodeId: episodeId) }
    }

    private func reload() { status = .loading; Task { status = await TranscriptStore.load(ws, episodeId: episodeId) } }
    private func generate() { status = .loading; Task { status = await TranscriptStore.request(ws, episodeId: episodeId) } }
    private func message(_ icon: String, _ title: String, _ body: String, action: (String, () -> Void)) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 30)).foregroundStyle(Brand.accent)
            Text(title).font(.display(20))
            Text(body).font(.subheadline).foregroundStyle(Brand.muted).multilineTextAlignment(.center)
            Button(action.0, action: action.1).buttonStyle(.glassProminent).tint(Brand.accent).foregroundStyle(Brand.ink).controlSize(.large)
        }
        .padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Tap-to-seek lines, current-line highlight, in-episode search (spec §3.8).
private struct TranscriptLines: View {
    @Environment(Workspace.self) private var ws
    let transcript: Transcript
    @Binding var query: String
    let embedded: Bool

    private var isCurrentEpisode: Bool { ws.player.episode?.id == transcript.episodeId }
    private var currentIndex: Int? {
        guard isCurrentEpisode else { return nil }
        return transcript.segments.lastIndex { $0.startMs <= ws.player.positionMs }
    }
    private var lines: [(Int, TranscriptSegment)] {
        let all = Array(transcript.segments.enumerated()).map { ($0.offset, $0.element) }
        guard let q = query.trimmedOrNil else { return all }
        return all.filter { $0.1.text.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(Brand.muted)
                TextField("Search this transcript", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Brand.muted) } }
            }
            .padding(.horizontal, 14).frame(height: 42).glassEffect(.regular, in: .capsule)
            .padding(.horizontal, 20).padding(.vertical, 8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(lines, id: \.0) { idx, seg in
                            Button { if isCurrentEpisode { ws.player.seek(toMs: seg.startMs) } } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Text(Fmt.clock(seg.startMs)).font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(Brand.muted).frame(width: 44, alignment: .leading).padding(.top, 3)
                                    Text(highlight(seg.text)).font(.system(size: idx == currentIndex ? 19 : 17, weight: idx == currentIndex ? .semibold : .regular))
                                        .foregroundStyle(idx == currentIndex ? Brand.text : Brand.muted).multilineTextAlignment(.leading)
                                }
                                .padding(.vertical, 8).padding(.horizontal, 12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(idx == currentIndex ? Brand.accent.opacity(0.16) : .clear, in: .rect(cornerRadius: 14))
                            }
                            .buttonStyle(.plain).id(idx)
                        }
                    }
                    .padding(.horizontal, 12).padding(.bottom, 12)
                }
                .onChange(of: currentIndex) { _, new in if let new, query.isEmpty { withAnimation(.easeInOut) { proxy.scrollTo(new, anchor: .center) } } }
            }
        }
    }

    private func highlight(_ text: String) -> AttributedString {
        var a = AttributedString(text)
        if let q = query.trimmedOrNil, let r = a.range(of: q, options: .caseInsensitive) { a[r].backgroundColor = Brand.amber.opacity(0.4); a[r].foregroundColor = Brand.text }
        return a
    }
}
