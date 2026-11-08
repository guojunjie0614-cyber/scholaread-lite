# Inter

Inter 4.1 by Rasmus Andersson, bundled under the SIL Open Font License 1.1 in `renderer/public/licenses/Inter-LICENSE.txt` (copied into the production bundle by Vite).

Source: https://rsms.me/inter/ and https://github.com/rsms/inter/releases/tag/v4.1

Unmodified font files:

- https://rsms.me/inter/font-files/InterVariable.woff2?v=4.1
- https://rsms.me/inter/font-files/InterVariable-Italic.woff2?v=4.1

The renderer uses Inter for the main workspace UI, with PingFang SC for Chinese on macOS. Reading prose uses the selected system serif or sans-serif family. Monospaced code retains its existing font stack. Fonts are bundled by Vite and load locally when offline.

# Sidebar fonts

The sidebar uses Schibsted Grotesk Variable (400–900) and Noto Sans SC Variable (100–900), matching the reference typography. Paper titles use weight 450, navigation actions use weight 500, and supporting metadata uses smaller text. Selection changes the background without changing text weight.

The unmodified WOFF2 assets were obtained from the locally installed Kimi Code application's `desktop-dist/assets/SchibstedGrotesk_wght_-DIzGrWVg.woff2` and `NotoSansSC_wght_-BkPpiACN.woff2`. They are bundled here as `SchibstedGroteskVariable.woff2` and `NotoSansSCVariable.woff2`, so the application does not depend on Kimi Code being installed.

Both font families use SIL Open Font License 1.1. Copyright notices and license text are distributed in `renderer/public/licenses/SchibstedGrotesk-LICENSE.txt` and `NotoSansSC-LICENSE.txt`.

- Schibsted Grotesk: https://github.com/schibsted/schibsted-grotesk — license: https://github.com/google/fonts/blob/main/ofl/schibstedgrotesk/OFL.txt
- Noto Sans SC: https://github.com/notofonts/noto-cjk — license: https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt
