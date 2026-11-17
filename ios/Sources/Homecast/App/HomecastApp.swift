import SwiftUI
import UIKit
import CarPlay

@main
struct HomecastApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        // Space Grotesk large titles: the brand display face on Liquid Glass navigation bars.
        UINavigationBar.appearance().largeTitleTextAttributes = [.font: UIFont(name: "SpaceGrotesk-Bold", size: 34) ?? .systemFont(ofSize: 34, weight: .bold)]
        UINavigationBar.appearance().titleTextAttributes = [.font: UIFont(name: "SpaceGrotesk-Bold", size: 17) ?? .systemFont(ofSize: 17, weight: .bold)]
    }

    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // Whatever arrived while you were away is on screen now: record it as seen so it isn't announced later.
                Task { @MainActor in
                    guard let ws = AppEnvironment.shared.workspace else { return }
                    await ws.sync.sync()
                    await NewEpisodeNotifier.check(ws, notify: false)
                }
            case .background: NewEpisodeNotifier.schedule()
            default: break
            }
        }
    }
}

/// Routes scene sessions: the CarPlay role gets its template scene; everything else is the SwiftUI window.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NewEpisodeNotifier.register()
        _ = AppEnvironment.shared // CarPlay can launch the app with no phone UI: start the session and player now
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if connectingSceneSession.role == .carTemplateApplication {
            let cfg = UISceneConfiguration(name: "Homecast CarPlay", sessionRole: connectingSceneSession.role)
            cfg.delegateClass = CarPlaySceneDelegate.self
            return cfg
        }
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        DownloadManager.backgroundCompletion = completionHandler
    }
}
