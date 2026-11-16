import CarPlay
import UIKit

/// CarPlay audio scene (spec §3.12). Requires the `com.apple.developer.carplay-audio` entitlement, which Apple must approve.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var controller: CarPlayController?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        MainActor.assumeIsolated {
            let c = CarPlayController(interfaceController: interfaceController)
            controller = c
            c.start()
        }
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        MainActor.assumeIsolated {
            controller?.stop()
            controller = nil
        }
    }
}
