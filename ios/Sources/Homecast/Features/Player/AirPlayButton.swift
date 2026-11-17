import AVKit
import SwiftUI

/// The system's route picker: AirPlay speakers, TVs and receivers (and Bluetooth). AVPlayer hands playback to the chosen
/// route by itself, whether the episode is streaming or a download, and the position keeps syncing as before.
struct AirPlayButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = UIColor(Brand.text)
        v.activeTintColor = UIColor(Brand.accent)
        v.prioritizesVideoDevices = false
        v.isAccessibilityElement = true
        v.accessibilityLabel = "AirPlay"
        return v
    }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
