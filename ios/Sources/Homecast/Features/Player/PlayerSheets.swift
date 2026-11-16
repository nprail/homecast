import GRDB
import SwiftUI

// MARK: Speed (spec §3.3)

struct SpeedSheet: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    @State private var scope: Player.SpeedScope = .podcast
    private let presets: [Double] = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0]

    var body: some View {
        let p = ws.player
        VStack(spacing: 18) {
            Text("Playback speed").font(.display(20)).padding(.top, 22)
            Text(Fmt.speed(p.speed)).font(.display(54)).foregroundStyle(Brand.accent).contentTransition(.numericText(value: p.speed)).animation(.snappy, value: p.speed)
            HStack(spacing: 18) {
                stepButton("minus", -0.1)
                Slider(value: Binding(get: { p.speed }, set: { p.setSpeed($0, scope: scope) }), in: 0.5 ... 3.0, step: 0.1).tint(Brand.accent)
                stepButton("plus", 0.1)
            }
            .padding(.horizontal, 24)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(presets, id: \.self) { s in
                    Button { p.setSpeed(s, scope: scope); Haptics.tap() } label: {
                        Text(Fmt.speed(s)).font(.display(15)).frame(maxWidth: .infinity, minHeight: 40)
                            .foregroundStyle(abs(p.speed - s) < 0.05 ? Brand.ink : Brand.text)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(abs(p.speed - s) < 0.05 ? .regular.tint(Brand.accent).interactive() : .regular.interactive(), in: .capsule)
                }
            }
            .padding(.horizontal, 24)
            VStack(spacing: 10) {
                Picker("Apply to", selection: $scope) {
                    Text("This podcast").tag(Player.SpeedScope.podcast)
                    Text("All podcasts").tag(Player.SpeedScope.global)
                }
                .pickerStyle(.segmented)
                if p.speedIsOverride {
                    Button("Clear \(p.podcast?.title ?? "podcast") override (use default)") { p.clearSpeedOverride() }
                        .font(.footnote).foregroundStyle(Brand.amber)
                }
            }
            .padding(.horizontal, 24)
            Spacer(minLength: 0)
        }
        .brandScreen()
        .preferredColorScheme(.dark)
    }

    private func stepButton(_ icon: String, _ delta: Double) -> some View {
        Button { ws.player.setSpeed(ws.player.speed + delta, scope: scope); Haptics.tap() } label: {
            Image(systemName: icon).font(.system(size: 16, weight: .bold)).frame(width: 40, height: 40)
        }
        .buttonStyle(.plain).glassEffect(.regular.interactive(), in: .circle).accessibilityLabel(delta > 0 ? "Faster" : "Slower")
    }
}

// MARK: Sleep timer (spec §3.4)

struct SleepSheet: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    @State private var custom = 20

    var body: some View {
        let p = ws.player
        VStack(spacing: 16) {
            Text("Sleep timer").font(.display(20)).padding(.top, 22)
            if let r = p.sleepRemaining, p.sleep != .off {
                VStack(spacing: 4) {
                    Text(p.sleep == .endOfEpisode ? "Stops at end of episode" : Fmt.sleepRemaining(r)).font(.display(40)).foregroundStyle(Brand.accent).monospacedDigit()
                    Text("Fades out over the last 10 seconds. Shake or tap to extend.").font(.footnote).foregroundStyle(Brand.muted).multilineTextAlignment(.center)
                }
                .padding(.vertical, 6)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach([5, 15, 30, 45, 60], id: \.self) { m in
                    chip("\(m) min") { p.setSleepTimer(minutes: m); dismiss() }
                }
                chip("End of episode", selected: p.sleep == .endOfEpisode) { p.setSleep(.endOfEpisode); dismiss() }
            }
            .padding(.horizontal, 24)
            HStack {
                Stepper(value: $custom, in: 1 ... 480, step: 5) {
                    Text("Custom: \(custom) min").font(.system(size: 16, weight: .semibold))
                }
                Button("Start") { p.setSleepTimer(minutes: custom); dismiss() }.buttonStyle(.glassProminent).tint(Brand.accent).foregroundStyle(Brand.ink)
            }
            .padding(.horizontal, 24)
            if p.sleep != .off {
                Button(role: .destructive) { p.setSleep(.off); dismiss() } label: { Text("Turn off timer").frame(maxWidth: .infinity) }
                    .buttonStyle(.glass).controlSize(.large).padding(.horizontal, 24)
            }
            Spacer(minLength: 0)
        }
        .brandScreen()
        .preferredColorScheme(.dark)
    }

    private func chip(_ text: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text).font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 48).foregroundStyle(selected ? Brand.ink : Brand.text)
        }
        .buttonStyle(.plain).glassEffect(selected ? .regular.tint(Brand.accent).interactive() : .regular.interactive(), in: .rect(cornerRadius: 16))
    }
}

// MARK: Up Next inside the player

struct QueueSheet: View {
    @Environment(Workspace.self) private var ws
    @StateObject private var queue: Live<[EpisodeItem]>

    init() {
        let env = AppEnvironment.shared
        _queue = StateObject(wrappedValue: Live([], in: env.workspace?.db) { d in
            let q = try Playlist.fetchOne(d, key: RecordID.upNext(userId: env.workspace?.user.id ?? "")).map { $0.deleted ? [] : $0.episodeIds } ?? []
            return try d.orderedEpisodeItems(ids: q)
        })
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(queue.value) { item in
                    EpisodeRow(item: item, listIds: queue.value.map(\.id), listLabel: "Up Next")
                        .listRowBackground(Color.clear)
                }
                .onDelete { for i in $0 { ws.data.dequeue(queue.value[i].id) } }
                .onMove { ws.data.moveInQueue(from: $0, to: $1) }
            }
            .listStyle(.plain)
            .overlay { if queue.value.isEmpty { EmptyState(icon: "text.line.first.and.arrowtriangle.forward", title: "Nothing queued", message: "Add episodes to Up Next and they'll play in order.") } }
            .navigationTitle("Up Next")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { EditButton() }
            .brandScreen()
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: Bookmarks (spec §3.2)

struct BookmarkSheet: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    let target: UIState.BookmarkTarget
    @State private var title = ""
    @State private var note = ""
    @State private var preview: String?
    @FocusState private var focus: Field?
    enum Field { case title, note }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Image(systemName: "bookmark.fill").foregroundStyle(Brand.amber)
                        Text(Fmt.clock(target.positionMs)).font(.display(20)).monospacedDigit()
                        Spacer()
                    }
                    if let preview {
                        Text("“\(preview)”").font(.system(size: 15)).foregroundStyle(Brand.muted).italic()
                    }
                }
                Section("Title (optional)") { TextField("Name this moment", text: $title).focused($focus, equals: .title).submitLabel(.next) }
                Section("Note (optional)") { TextField("Add a note", text: $note, axis: .vertical).lineLimit(3 ... 6).focused($focus, equals: .note) }
            }
            .navigationTitle(target.existing == nil ? "Add Bookmark" : "Edit Bookmark")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if let b = target.existing { ws.data.updateBookmark(b.id, title: title, note: note) }
                        else { ws.data.addBookmark(episodeId: target.episodeId, positionMs: target.positionMs, title: title, note: note); Haptics.success(); Toaster.shared.show("Bookmark added") }
                        dismiss()
                    }.fontWeight(.bold)
                }
            }
            .brandScreen()
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium, .large])
        .onAppear {
            title = target.existing?.title ?? ""; note = target.existing?.note ?? ""
            preview = TranscriptStore.preview(db: ws.db, episodeId: target.episodeId, atMs: target.positionMs)
        }
    }
}

// MARK: Add to playlist

struct PlaylistPickerSheet: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    let episodeId: String
    @StateObject private var playlists: Live<[Playlist]>
    @State private var creating = false
    @State private var newName = ""

    init(episodeId: String) {
        self.episodeId = episodeId
        _playlists = StateObject(wrappedValue: Live([], in: AppEnvironment.shared.workspace?.db) { d in
            try Playlist.filter(Column("deleted") == false).filter(Column("name") != RecordID.upNextName).order(Column("name")).fetchAll(d)
        })
    }

    var body: some View {
        NavigationStack {
            List {
                Button { creating = true } label: { Label("New Playlist…", systemImage: "plus.circle.fill").foregroundStyle(Brand.accent) }
                    .listRowBackground(Color.clear)
                ForEach(playlists.value) { p in
                    Button {
                        ws.data.addToPlaylist(p.id, episodeId: episodeId)
                        Toaster.shared.show("Added to \(p.name)"); dismiss()
                    } label: {
                        HStack { Text(p.name).foregroundStyle(Brand.text); Spacer(); Text(Fmt.plural(p.episodeIds.count, "episode")).font(.footnote).foregroundStyle(Brand.muted) }
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .navigationTitle("Add to Playlist").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .alert("New Playlist", isPresented: $creating) {
                TextField("Name", text: $newName)
                Button("Create") {
                    let id = ws.data.createPlaylist(name: newName, episodeIds: [episodeId])
                    _ = id; Toaster.shared.show("Added to \(newName.trimmedOrNil ?? "Untitled")"); newName = ""; dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
            .brandScreen()
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium])
    }
}
