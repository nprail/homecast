import GRDB
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    @State private var env = AppEnvironment.shared
    @State private var settings = UserSettings(id: "")
    @State private var sessions: [SessionDTO] = []
    @State private var storageCap = DeviceSettings.storageCapMB
    @State private var wifiOnly = DeviceSettings.wifiOnly
    @State private var importing = false
    @State private var exportFile: ExportFile?
    @State private var showPassword = false
    @State private var confirmSignOut = false
    @State private var notifyOn = DeviceSettings.notifyNewEpisodes
    @State private var notifyDenied = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        HomecastLogo(size: 40).padding(12).glassEffect(.regular.tint(Brand.accent.opacity(0.12)), in: .rect(cornerRadius: 20))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ws.user.username).font(.display(20)).foregroundStyle(Brand.text)
                            Text(env.serverURLString).font(.system(size: 13)).foregroundStyle(Brand.muted).lineLimit(1)
                        }
                        Spacer()
                        if ws.user.isAdmin { Text("ADMIN").font(.system(size: 10, weight: .bold)).tracking(1).foregroundStyle(Brand.ink).padding(.horizontal, 8).padding(.vertical, 4).background(Brand.amber, in: .capsule) }
                    }
                    .listRowBackground(Color.clear)
                    syncRow
                    if ws.user.isAdmin, let url = URL(string: env.serverURLString + "/admin") { Link(destination: url) { Label("Open admin dashboard", systemImage: "gauge.with.dots.needle.33percent") } }
                } header: { Text("Account") }

                Section {
                    Stepper(value: Binding(get: { settings.defaultSpeed }, set: { ws.data.setDefaultSpeed($0); ws.player.refreshSpeed() }), in: 0.5 ... 3.0, step: 0.1) {
                        HStack { Text("Default speed"); Spacer(); Text(Fmt.speed(settings.defaultSpeed)).font(.display(17)).foregroundStyle(Brand.accent) }
                    }
                    if !settings.podcastSpeeds.isEmpty {
                        Text("\(Fmt.plural(settings.podcastSpeeds.count, "podcast")) with their own speed. Set or clear these from a podcast's menu.").font(.footnote).foregroundStyle(Brand.muted)
                    }
                } header: { Text("Playback") } footer: { Text("Synced across your devices. A podcast's own speed overrides this default.") }

                Section {
                    Toggle("New episode notifications", isOn: $notifyOn).tint(Brand.accent)
                        .onChange(of: notifyOn) { _, on in
                            Task {
                                if on {
                                    if await !NewEpisodeNotifier.enable() { notifyOn = false; notifyDenied = await NewEpisodeNotifier.authorizationDenied() }
                                } else { NewEpisodeNotifier.disable() }
                            }
                        }
                    if notifyDenied, let url = URL(string: UIApplication.openSettingsURLString) {
                        Link(destination: url) { Label("Turn on notifications for Homecast in Settings", systemImage: "bell.badge") }.font(.footnote)
                    }
                } header: { Text("Notifications") } footer: { Text("Homecast checks for new episodes in the background and notifies you about podcasts with the bell on (set it from a podcast's menu). iOS decides when it runs, so a notification can arrive some time after the episode is published.") }

                Section {
                    Toggle("Download on Wi-Fi only", isOn: $wifiOnly).tint(Brand.accent).onChange(of: wifiOnly) { _, v in DeviceSettings.wifiOnly = v }
                    Picker("Storage cap", selection: $storageCap) {
                        Text("Unlimited").tag(0); Text("1 GB").tag(1000); Text("2 GB").tag(2000); Text("5 GB").tag(5000); Text("10 GB").tag(10000)
                    }
                    .onChange(of: storageCap) { _, v in DeviceSettings.storageCapMB = v; ws.downloads.enforceCap(incoming: 0) }
                    LabeledContent("Used", value: Fmt.bytes(ws.downloads.totalBytes()))
                } header: { Text("This device") } footer: { Text("Oldest played episodes are removed first when the cap is reached.") }

                Section("Library") {
                    Button { ui.showAddPodcast = true } label: { Label("Add a podcast", systemImage: "plus.circle") }
                    Button { importing = true } label: { Label("Import OPML", systemImage: "square.and.arrow.down") }
                    Button { Task { await export("/opml/export", name: "homecast.opml") } } label: { Label("Export OPML", systemImage: "square.and.arrow.up") }
                    Button { Task { await export("/me/export", name: "homecast-export.json") } } label: { Label("Export all my data", systemImage: "externaldrive") }
                }

                Section("Signed-in devices") {
                    ForEach(sessions) { s in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.deviceName + (s.current ? " (this device)" : "")).font(.system(size: 15, weight: .semibold))
                                Text("Last used " + Fmt.released(Date(timeIntervalSince1970: s.lastUsedAt / 1000))).font(.footnote).foregroundStyle(Brand.muted)
                            }
                            Spacer()
                            if !s.current { Button("Sign out") { Task { try? await ws.api.delete("/auth/sessions/\(s.id)"); await loadSessions() } }.font(.footnote).buttonStyle(.bordered).tint(Brand.danger) }
                        }
                    }
                }

                Section {
                    Button { showPassword = true } label: { Label("Change password", systemImage: "key") }
                    Button(role: .destructive) { confirmSignOut = true } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right") }
                } footer: { Text("Homecast \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0") · Self-hosted podcast player").frame(maxWidth: .infinity).padding(.top, 12) }
            }
            .navigationTitle("Settings")
            .brandScreen()
            .task { await loadSessions() }
            .task { do { for try await s in ValueObservation.tracking({ try $0.settings(userId: ws.user.id) }).values(in: ws.db.pool) { settings = s } } catch {} }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.xml, .data, .text]) { r in if case .success(let u) = r { Task { await importOPML(u) } } }
            .sheet(item: $exportFile) { ShareSheet(url: $0.url) }
            .sheet(isPresented: $showPassword) { ChangePasswordSheet().environment(ws) }
            .confirmationDialog("Sign out of Homecast?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) { Task { await env.signOut() } }
            } message: { Text("Downloads on this device are removed. Your library stays on the server.") }
        }
    }

    private var syncRow: some View {
        let s = ws.sync
        return HStack {
            Label("Sync", systemImage: "arrow.triangle.2.circlepath")
            Spacer()
            Text(s.state == .syncing ? "Syncing…" : s.state == .offline ? "Offline" : s.state == .error ? "Problem: retrying" : s.lastSyncAt.map { "Synced " + Fmt.released($0) } ?? "Not yet")
                .font(.footnote).foregroundStyle(s.state == .error ? Brand.amber : Brand.muted)
            Button { Task { await ws.sync.sync() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless).accessibilityLabel("Sync now")
        }
    }

    private func loadSessions() async {
        struct R: Decodable { var sessions: [SessionDTO] }
        if let r: R = try? await ws.api.get("/auth/sessions") { sessions = r.sessions }
    }

    private func importOPML(_ u: URL) async {
        let scoped = u.startAccessingSecurityScopedResource()
        defer { if scoped { u.stopAccessingSecurityScopedResource() } }
        do {
            let r: OPMLImportResponse = try await ws.api.postText("/opml/import", text: try String(contentsOf: u, encoding: .utf8), contentType: "text/x-opml")
            await ws.sync.sync()
            Toaster.shared.show(r.summary)
        } catch { Toaster.shared.show(error.localizedDescription) }
    }

    private func export(_ path: String, name: String) async {
        do {
            let text = try await ws.api.getText(path)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try text.write(to: url, atomically: true, encoding: .utf8)
            exportFile = ExportFile(url: url)
        } catch { Toaster.shared.show(error.localizedDescription) }
    }
}

struct ExportFile: Identifiable { let id = UUID(); let url: URL }

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

struct ChangePasswordSheet: View {
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var next = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section { SecureField("Current password", text: $current).textContentType(.password); SecureField("New password (10+ characters)", text: $next).textContentType(.newPassword) }
                    footer: { if let error { Text(error).foregroundStyle(Brand.danger) } else { Text("Changing your password signs out your other devices.") } }
            }
            .navigationTitle("Change Password").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        busy = true
                        Task {
                            do { let _: EmptyResponse = try await ws.api.post("/auth/change-password", json: ["currentPassword": current, "newPassword": next]); Toaster.shared.show("Password changed"); dismiss() }
                            catch { self.error = error.localizedDescription }
                            busy = false
                        }
                    }.fontWeight(.bold).disabled(current.isEmpty || next.count < 10 || busy)
                }
            }
            .brandScreen()
        }
        .preferredColorScheme(.dark).presentationDetents([.medium])
    }
}
