import SwiftUI

/// Sign in / create account against a self-hosted server (spec §3.9: invite-only registration, bootstrap token for the first admin).
struct AuthView: View {
    @State private var env = AppEnvironment.shared
    enum Mode: String, CaseIterable, Identifiable { case signIn = "Sign In", join = "Join"; var id: String { rawValue } }
    @State private var mode: Mode = .signIn
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var invite = ""
    @State private var bootstrap = ""
    @State private var newServer = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    enum Field { case server, username, password, invite }

    var body: some View {
        ZStack {
            BrandBackdrop()
            ScrollView {
                VStack(spacing: 26) {
                    VStack(spacing: 14) {
                        HomecastLogo(size: 76)
                            .padding(22).glassEffect(.regular.tint(Brand.accent.opacity(0.12)), in: .rect(cornerRadius: 34))
                        Text("Homecast").font(.display(40)).tracking(-0.8).foregroundStyle(Brand.text)
                        Text("Your podcasts, on your own server.").font(.system(size: 16)).foregroundStyle(Brand.muted)
                    }
                    .padding(.top, 36)

                    Picker("Mode", selection: $mode) { ForEach(Mode.allCases) { Text($0.rawValue).tag($0) } }
                        .pickerStyle(.segmented)

                    VStack(spacing: 12) {
                        field("Server", systemImage: "server.rack", text: $server, prompt: "podcasts.example.com", field: .server, keyboard: .URL)
                        field("Username", systemImage: "person.fill", text: $username, prompt: "Username", field: .username)
                        secure
                        if mode == .join {
                            if newServer { field("Bootstrap token", systemImage: "key.fill", text: $bootstrap, prompt: "From the server log", field: .invite) }
                            else { field("Invite code", systemImage: "ticket.fill", text: $invite, prompt: "inv_…", field: .invite) }
                            Toggle(isOn: $newServer) { Text("I'm setting up a new server").font(.system(size: 14)).foregroundStyle(Brand.muted) }
                                .tint(Brand.accent)
                        }
                    }
                    .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 28))

                    if let error {
                        Text(error).font(.system(size: 14, weight: .medium)).foregroundStyle(Brand.danger).multilineTextAlignment(.center).accessibilityAddTraits(.isStaticText)
                    }
                    PrimaryActionButton(title: mode == .signIn ? "Sign In" : "Create Account", busy: busy, action: submit)
                        .disabled(server.isEmpty || username.isEmpty || password.isEmpty)
                    Text(mode == .join ? "Registration is invite-only. Ask your server's admin for a code." : "Passwords are at least 10 characters. Use TLS (https) when your server is on the internet.")
                        .font(.footnote).foregroundStyle(Brand.muted).multilineTextAlignment(.center)
                }
                .padding(.horizontal, 22).padding(.bottom, 30)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear { server = env.serverURLString }
        .animation(.smooth, value: mode)
        .animation(.smooth, value: newServer)
        .onSubmit(next)
    }

    private var secure: some View {
        HStack(spacing: 12) {
            Image(systemName: "lock.fill").foregroundStyle(Brand.muted).frame(width: 20)
            SecureField("Password", text: $password).focused($focus, equals: .password).textContentType(mode == .signIn ? .password : .newPassword).submitLabel(mode == .signIn ? .go : .next)
        }
        .frame(height: 48)
        .accessibilityLabel("Password")
    }

    private func field(_ label: String, systemImage: String, text: Binding<String>, prompt: String, field: Field, keyboard: UIKeyboardType = .default) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage).foregroundStyle(Brand.muted).frame(width: 20)
            TextField(label, text: text, prompt: Text(prompt).foregroundStyle(Brand.muted.opacity(0.7)))
                .focused($focus, equals: field).keyboardType(keyboard)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.next)
        }
        .frame(height: 48)
        .accessibilityLabel(label)
    }

    private func next() {
        switch focus {
        case .server: focus = .username
        case .username: focus = .password
        case .password: if mode == .signIn { submit() } else { focus = .invite }
        default: submit()
        }
    }

    private func submit() {
        guard !busy else { return }
        busy = true; error = nil; focus = nil
        Task {
            do {
                if mode == .signIn { try await env.signIn(server: server, username: username, password: password) }
                else { try await env.register(server: server, username: username, password: password, inviteCode: newServer ? nil : invite, bootstrapToken: newServer ? bootstrap : nil) }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
