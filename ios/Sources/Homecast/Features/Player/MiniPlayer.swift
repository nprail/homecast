import SwiftUI

/// The mini player lives in the tab bar's bottom accessory (iOS 26): it floats on Liquid Glass above the tabs and
/// collapses inline with the tab bar when the user scrolls.
struct MiniPlayer: View {
    @Environment(Workspace.self) private var ws
    @Environment(UIState.self) private var ui
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        let player = ws.player
        HStack(spacing: 12) {
            Artwork(url: player.podcast?.imageUrl, cornerRadius: 9).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 1) {
                Text(player.episode?.title ?? "Not playing")
                    .font(.system(size: 14, weight: .semibold)).lineLimit(1).foregroundStyle(Brand.text)
                if placement != .inline {
                    Text(player.podcast?.title ?? "").font(.system(size: 12)).lineLimit(1).foregroundStyle(Brand.muted)
                }
            }
            Spacer(minLength: 0)
            Button { player.isPlaying ? player.pause() : player.resume(); Haptics.tap() } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 18, weight: .bold)).frame(width: 40, height: 40)
            }
            .accessibilityLabel(player.isPlaying ? "Pause" : "Play")
            if placement != .inline {
                Button { player.forward() } label: {
                    Image(systemName: "goforward.30").font(.system(size: 20)).frame(width: 40, height: 40)
                }
                .accessibilityLabel("Forward 30 seconds")
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(Brand.text)
        .padding(.horizontal, 14)
        .contentShape(.rect)
        .onTapGesture { ui.showPlayer = true }
        .accessibilityElement(children: .contain)
        .accessibilityHint("Opens the player")
    }
}

extension View {
    /// Shows the mini player accessory only while an episode is loaded.
    @ViewBuilder func miniPlayerAccessory(enabled: Bool) -> some View {
        if #available(iOS 26.1, *) {
            self.tabViewBottomAccessory(isEnabled: enabled) { MiniPlayer() }
        } else {
            self.tabViewBottomAccessory { MiniPlayer() }
        }
    }
}
