import GRDB
import SwiftUI

struct PlaylistSummary: Identifiable, Hashable, Sendable { var playlist: Playlist; var id: String { playlist.id } }
struct SmartSummary: Identifiable, Hashable, Sendable { var playlist: SmartPlaylist; var count: Int; var id: String { playlist.id } }

struct QueueView: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    enum Segment: String, CaseIterable, Identifiable { case upNext = "Up Next", playlists = "Playlists", smart = "Smart"; var id: String { rawValue } }
    @State private var segment: Segment = {
        ["playlists": .playlists, "smart": .smart][ProcessInfo.processInfo.environment["HC_SEGMENT"] ?? ""] ?? .upNext
    }()
    @StateObject private var queue: Live<[EpisodeItem]>
    @StateObject private var playlists: Live<[PlaylistSummary]>
    @StateObject private var smart: Live<[SmartSummary]>
    @State private var creating = false
    @State private var newName = ""
    @State private var editingSmart: SmartPlaylist?
    @State private var newSmart = false

    init() {
        let env = AppEnvironment.shared
        let db = env.workspace?.db
        let uid = env.workspace?.user.id ?? ""
        _queue = StateObject(wrappedValue: Live([], in: db) { d in
            let ids = try Playlist.fetchOne(d, key: RecordID.upNext(userId: uid)).map { $0.deleted ? [] : $0.episodeIds } ?? []
            return try d.orderedEpisodeItems(ids: ids)
        })
        _playlists = StateObject(wrappedValue: Live([], in: db) { d in
            try Playlist.filter(Column("deleted") == false).filter(Column("name") != RecordID.upNextName).order(sql: "name COLLATE NOCASE").fetchAll(d).map(PlaylistSummary.init)
        })
        _smart = StateObject(wrappedValue: Live([], in: db) { d in
            let views = try d.episodeViews()
            let now = LocalData.nowMs()
            return try SmartPlaylist.filter(Column("deleted") == false).order(sql: "name COLLATE NOCASE").fetchAll(d).map { SmartSummary(playlist: $0, count: SmartEvaluator.evaluate($0.definition, episodes: views, now: now).count) }
        })
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    switch segment {
                    case .upNext: upNextRows
                    case .playlists: playlistRows
                    case .smart: smartRows
                    }
                } header: {
                    Picker("View", selection: $segment) { ForEach(Segment.allCases) { Text($0.rawValue).tag($0) } }
                        .pickerStyle(.segmented).textCase(nil).padding(.bottom, 6)
                }
            }
            .listStyle(.plain)
            .navigationTitle(segment.rawValue)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    switch segment {
                    case .upNext:
                        Menu {
                            EditButton()
                            Button(role: .destructive) { ws.data.setQueue([]) } label: { Label("Clear Up Next", systemImage: "trash") }.disabled(queue.value.isEmpty)
                        } label: { Image(systemName: "ellipsis") }
                    case .playlists: Button { creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("New playlist")
                    case .smart: Button { newSmart = true } label: { Image(systemName: "plus") }.accessibilityLabel("New smart playlist")
                    }
                }
            }
            .alert("New Playlist", isPresented: $creating) {
                TextField("Name", text: $newName)
                Button("Create") { ws.data.createPlaylist(name: newName); newName = "" }
                Button("Cancel", role: .cancel) { newName = "" }
            }
            .sheet(isPresented: $newSmart) { SmartPlaylistEditor(existing: nil).environment(ws) }
            .brandScreen()
            .routes()
        }
        .animation(.snappy, value: segment)
    }

    @ViewBuilder private var upNextRows: some View {
        if queue.value.isEmpty {
            EmptyState(icon: "text.line.first.and.arrowtriangle.forward", title: "Nothing queued", message: "Swipe an episode or use its menu to add it to Up Next. Episodes play in order, and the queue syncs across your devices.")
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
        } else {
            ForEach(queue.value) { item in
                NavigationLink(value: Route.episode(item.id)) {
                    EpisodeRow(item: item, listIds: queue.value.map(\.id), listLabel: "Up Next")
                }
                .listRowBackground(Color.clear)
            }
            .onDelete { for i in $0 { ws.data.dequeue(queue.value[i].id) } }
            .onMove { ws.data.moveInQueue(from: $0, to: $1) }
        }
    }

    @ViewBuilder private var playlistRows: some View {
        if playlists.value.isEmpty {
            EmptyState(icon: "music.note.list", title: "No playlists", message: "Make an ordered list of episodes and play it start to finish.").listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
        ForEach(playlists.value) { p in
            NavigationLink(value: Route.playlist(p.id)) {
                HStack(spacing: 14) {
                    Image(systemName: "music.note.list").font(.system(size: 18)).foregroundStyle(Brand.accent).frame(width: 46, height: 46).glassEffect(.regular, in: .rect(cornerRadius: 14))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.playlist.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Brand.text)
                        Text(Fmt.plural(p.playlist.episodeIds.count, "episode")).font(.system(size: 13)).foregroundStyle(Brand.muted)
                    }
                }
            }
            .listRowBackground(Color.clear)
        }
        .onDelete { for i in $0 { ws.data.deletePlaylist(playlists.value[i].id) } }
    }

    @ViewBuilder private var smartRows: some View {
        if smart.value.isEmpty {
            EmptyState(icon: "wand.and.stars", title: "No smart playlists", message: "Build rules like “unplayed, released this week, under 30 minutes”. They update on their own and work offline.").listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
        ForEach(smart.value) { s in
            NavigationLink(value: Route.smartPlaylist(s.id)) {
                HStack(spacing: 14) {
                    Image(systemName: "wand.and.stars").font(.system(size: 18)).foregroundStyle(Brand.amber).frame(width: 46, height: 46).glassEffect(.regular, in: .rect(cornerRadius: 14))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.playlist.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Brand.text)
                        Text("\(Fmt.plural(s.count, "episode")) · \(Fmt.plural(s.playlist.definition.rules.count, "rule"))").font(.system(size: 13)).foregroundStyle(Brand.muted)
                    }
                }
            }
            .listRowBackground(Color.clear)
        }
        .onDelete { for i in $0 { ws.data.deleteSmartPlaylist(smart.value[i].id) } }
    }
}

// MARK: Manual playlist (spec §3.6)

struct PlaylistDetailView: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    let playlistId: String
    struct Snap: Sendable { var playlist: Playlist?; var items: [EpisodeItem] = [] }
    @StateObject private var snap: Live<Snap>
    @State private var renaming = false
    @State private var name = ""

    init(playlistId: String) {
        self.playlistId = playlistId
        _snap = StateObject(wrappedValue: Live(Snap(), in: AppEnvironment.shared.workspace?.db) { d in
            guard let p = try Playlist.fetchOne(d, key: playlistId), !p.deleted else { return Snap() }
            return Snap(playlist: p, items: try d.orderedEpisodeItems(ids: p.episodeIds))
        })
    }

    var body: some View {
        let s = snap.value
        List {
            Section {
                ForEach(s.items) { item in
                    NavigationLink(value: Route.episode(item.id)) { EpisodeRow(item: item, listIds: s.items.map(\.id), listLabel: s.playlist?.name ?? "Playlist") }
                        .listRowBackground(Color.clear).episodeSwipe(item)
                }
                .onDelete { idx in ws.data.updatePlaylist(playlistId) { p in p.episodeIds.remove(atOffsets: idx) } }
                .onMove { from, to in ws.data.updatePlaylist(playlistId) { $0.episodeIds.move(fromOffsets: from, toOffset: to) } }
            } header: { actionsHeader(s.items) }
        }
        .listStyle(.plain)
        .overlay { if s.items.isEmpty { EmptyState(icon: "music.note.list", title: "Empty playlist", message: "Use “Add to Playlist…” on any episode.") } }
        .navigationTitle(s.playlist?.name ?? "Playlist").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    EditButton()
                    Button { name = s.playlist?.name ?? ""; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                    Button(role: .destructive) { ws.data.deletePlaylist(playlistId); dismiss() } label: { Label("Delete Playlist", systemImage: "trash") }
                } label: { Image(systemName: "ellipsis") }
            }
        }
        .alert("Rename Playlist", isPresented: $renaming) {
            TextField("Name", text: $name)
            Button("Save") { ws.data.updatePlaylist(playlistId) { $0.name = name.trimmedOrNil ?? $0.name } }
            Button("Cancel", role: .cancel) {}
        }
        .brandScreen()
    }

    private func actionsHeader(_ items: [EpisodeItem]) -> some View {
        PlaylistActions(items: items, label: snap.value.playlist?.name ?? "Playlist")
    }
}

/// Play in order / download everything (spec §3.5 "playlist download all").
struct PlaylistActions: View {
    @Environment(Workspace.self) private var ws
    let items: [EpisodeItem]
    let label: String
    var body: some View {
        HStack(spacing: 10) {
            Button {
                if let first = items.first { Task { await ws.player.play(first.id, in: items.map(\.id), label: label) } }
            } label: { Label("Play", systemImage: "play.fill").font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.ink).frame(maxWidth: .infinity, minHeight: 24) }
                .buttonStyle(.glassProminent).tint(Brand.accent).disabled(items.isEmpty)
            Button {
                items.filter { !$0.downloaded }.forEach { ws.downloads.enqueue($0.id) }
                Toaster.shared.show("Downloading \(items.filter { !$0.downloaded }.count) episodes")
            } label: { Label("Download All", systemImage: "arrow.down.circle").font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 24) }
                .buttonStyle(.glass).disabled(items.isEmpty || items.allSatisfy(\.downloaded))
        }
        .controlSize(.large).textCase(nil).padding(.bottom, 6)
    }
}

// MARK: Smart playlist detail + editor (spec §3.7)

struct SmartPlaylistDetailView: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    let id: String
    struct Snap: Sendable { var playlist: SmartPlaylist?; var items: [EpisodeItem] = [] }
    @StateObject private var snap: Live<Snap>
    @State private var editing = false

    init(id: String) {
        self.id = id
        _snap = StateObject(wrappedValue: Live(Snap(), in: AppEnvironment.shared.workspace?.db) { d in
            guard let p = try SmartPlaylist.fetchOne(d, key: id), !p.deleted else { return Snap() }
            let ids = SmartEvaluator.evaluate(p.definition, episodes: try d.episodeViews(), now: LocalData.nowMs())
            return Snap(playlist: p, items: try d.orderedEpisodeItems(ids: ids))
        })
    }

    var body: some View {
        let s = snap.value
        List {
            if let def = s.playlist?.definition {
                Text(summary(def)).font(.system(size: 13)).foregroundStyle(Brand.muted).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            Section {
                ForEach(s.items) { item in
                    NavigationLink(value: Route.episode(item.id)) { EpisodeRow(item: item, listIds: s.items.map(\.id), listLabel: s.playlist?.name ?? "Smart playlist") }
                        .listRowBackground(Color.clear).episodeSwipe(item)
                }
            } header: { PlaylistActions(items: s.items, label: s.playlist?.name ?? "Smart playlist") }
        }
        .listStyle(.plain)
        .overlay { if s.items.isEmpty { EmptyState(icon: "wand.and.stars", title: "No matches", message: "No episodes match these rules right now. This list updates as new episodes arrive.") } }
        .navigationTitle(s.playlist?.name ?? "Smart Playlist").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { editing = true } label: { Label("Edit Rules", systemImage: "slider.horizontal.3") }
                    Button(role: .destructive) { ws.data.deleteSmartPlaylist(id); dismiss() } label: { Label("Delete", systemImage: "trash") }
                } label: { Image(systemName: "ellipsis") }
            }
        }
        .sheet(isPresented: $editing) { if let p = s.playlist { SmartPlaylistEditor(existing: p).environment(ws) } }
        .brandScreen()
    }

    private func summary(_ def: SmartPlaylistDefinition) -> String {
        "Matches \(def.match == .all ? "all" : "any") of \(Fmt.plural(def.rules.count, "rule"))"
            + (def.limit.map { ", up to \($0) episodes" } ?? "") + (def.autoDownload == true ? " · auto-downloads results" : "")
    }
}

struct SmartPlaylistEditor: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    let existing: SmartPlaylist?
    @State private var def: SmartPlaylistDefinition = .blank()
    @StateObject private var podcasts: Live<[Podcast]>

    init(existing: SmartPlaylist?) {
        self.existing = existing
        let env = AppEnvironment.shared
        _podcasts = StateObject(wrappedValue: Live([], in: env.workspace?.db) { d in try Podcast.filter(keys: try d.subscribedPodcastIds()).order(sql: "title COLLATE NOCASE").fetchAll(d) })
    }

    private let limits = [10, 25, 50, 100, 200]
    private var sortKey: Binding<String> {
        Binding(get: { "\(def.sort.field.rawValue):\(def.sort.dir.rawValue)" }, set: { v in
            let p = v.split(separator: ":").map(String.init)
            def.sort = .init(field: .init(rawValue: p[0]) ?? .releasedAt, dir: .init(rawValue: p[1]) ?? .desc)
        })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("Name", text: $def.name) }
                Section {
                    Picker("Match", selection: $def.match) { Text("All rules").tag(SmartPlaylistDefinition.Match.all); Text("Any rule").tag(SmartPlaylistDefinition.Match.any) }.pickerStyle(.segmented)
                    ForEach(def.rules.indices, id: \.self) { i in
                        RuleEditor(rule: $def.rules[i], podcasts: podcasts.value)
                    }
                    .onDelete { def.rules.remove(atOffsets: $0) }
                    Menu {
                        Button("Podcast") { def.rules.append(.podcast(op: .in, ids: [])) }
                        Button("Status") { def.rules.append(.status(.unplayed)) }
                        Button("Released within") { def.rules.append(.releasedWithin(days: 7)) }
                        Button("Duration") { def.rules.append(.duration(op: .lt, minutes: 30)) }
                        Button("Downloaded") { def.rules.append(.downloaded(true)) }
                        Button("Starred") { def.rules.append(.starred(true)) }
                        Button("Title contains") { def.rules.append(.title(contains: "")) }
                    } label: { Label("Add Rule", systemImage: "plus.circle.fill").foregroundStyle(Brand.accent) }
                } header: { Text("Rules") }
                Section("Sort & limit") {
                    Picker("Sort by", selection: sortKey) {
                        Text("Newest first").tag("releasedAt:desc"); Text("Oldest first").tag("releasedAt:asc")
                        Text("Longest first").tag("duration:desc"); Text("Shortest first").tag("duration:asc")
                        Text("Title A to Z").tag("title:asc"); Text("Title Z to A").tag("title:desc")
                    }
                    Picker("Limit", selection: Binding(get: { def.limit ?? 50 }, set: { def.limit = $0 })) { ForEach(limits, id: \.self) { Text("\($0)").tag($0) } }
                    Toggle("Auto-download results", isOn: Binding(get: { def.autoDownload ?? false }, set: { def.autoDownload = $0 })).tint(Brand.accent)
                }
            }
            .navigationTitle(existing == nil ? "New Smart Playlist" : "Edit Smart Playlist").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        def.name = def.name.trimmedOrNil ?? "Smart playlist"
                        ws.data.saveSmartPlaylist(id: existing?.id, definition: def)
                        dismiss()
                    }.fontWeight(.bold)
                }
            }
            .brandScreen()
        }
        .preferredColorScheme(.dark)
        .onAppear { if let e = existing { def = e.definition } }
    }
}

private struct RuleEditor: View {
    @Binding var rule: SmartRule
    let podcasts: [Podcast]

    var body: some View {
        switch rule {
        case .podcast(let op, let ids):
            VStack(alignment: .leading, spacing: 8) {
                Picker("Podcast", selection: Binding(get: { op }, set: { rule = .podcast(op: $0, ids: ids) })) { Text("Podcast is one of").tag(SmartRule.SetOp.in); Text("Podcast is none of").tag(SmartRule.SetOp.notIn) }
                ForEach(podcasts) { p in
                    Toggle(p.title, isOn: Binding(get: { ids.contains(p.id) }, set: { on in
                        var n = ids; if on { n.append(p.id) } else { n.removeAll { $0 == p.id } }
                        rule = .podcast(op: op, ids: n)
                    })).tint(Brand.accent).font(.system(size: 15))
                }
            }
        case .status(let s):
            Picker("Status", selection: Binding(get: { s }, set: { rule = .status($0) })) { Text("Unplayed").tag(PlayStatus.unplayed); Text("In progress").tag(PlayStatus.inProgress); Text("Played").tag(PlayStatus.played) }
        case .releasedWithin(let d):
            Stepper(value: Binding(get: { d }, set: { rule = .releasedWithin(days: $0) }), in: 1 ... 3650, step: 1) { Text("Released within \(Int(d)) day\(d == 1 ? "" : "s")") }
        case .duration(let op, let m):
            VStack(alignment: .leading) {
                Picker("Duration", selection: Binding(get: { op }, set: { rule = .duration(op: $0, minutes: m) })) { Text("Shorter than").tag(SmartRule.CompareOp.lt); Text("Longer than").tag(SmartRule.CompareOp.gt) }.pickerStyle(.segmented)
                Stepper(value: Binding(get: { m }, set: { rule = .duration(op: op, minutes: $0) }), in: 1 ... 1000, step: 5) { Text("\(Int(m)) minutes") }
            }
        case .downloaded(let b):
            Picker("Downloaded", selection: Binding(get: { b }, set: { rule = .downloaded($0) })) { Text("Downloaded").tag(true); Text("Not downloaded").tag(false) }
        case .starred(let b):
            Picker("Starred", selection: Binding(get: { b }, set: { rule = .starred($0) })) { Text("Starred").tag(true); Text("Not starred").tag(false) }
        case .title(let t):
            TextField("Title contains", text: Binding(get: { t }, set: { rule = .title(contains: $0) }))
        }
    }
}
