# PlayDeck

PlayDeck is a gamepad-driven 10-foot Plex client built for the **Steam Deck OLED in SteamOS Gaming Mode (gamescope)**, combining a **90 fps browse UI** with **native HDR10 and Dolby Vision Direct Play** playback.

## Features

- **Real HDR10 & Dolby Vision Output**: Uses a bundled `mpv` (`vo=gpu-next` / Vulkan / `libplacebo`) with the Gamescope WSI Vulkan layer to output PQ/BT.2020 and pass through static HDR metadata. Supports HDR10, HDR10+, and Dolby Vision (Profile 5 / 8.1 / 8.4) RPU reshaping with VA-API hardware decoding.
- **Automatic Refresh Rate Matching**: Talks to `gamescope_control` before playback starts to switch the Steam Deck OLED panel to an exact integer multiple of the video frame rate (23.976/24p → 72 Hz, 25p → 50 Hz, 29.97/30p → 90 Hz, 59.94/60p → 60 Hz) and restores 90 Hz on exit.
- **90 fps Gamepad Browse UI**: Supports QR/link-code sign-in, Plex Home user switching (with PIN), automatic multi-server connection probing (LAN preferred, relays excluded), cross-server merged Home, virtualized library grids, horizontal episode strips, and detailed stream/file inspection.
- **Gamepad-First Playback OSD**: Built-in audio and embedded/sidecar subtitle track switcher, intro/credits skip prompts, next-episode autoplay countdown, playback speed, audio/subtitle delay, subtitle styling and scaling, HDR subtitle/OSD peak brightness control (203 nits reference), and a real-time network throughput monitor.
- **Localization & Customization**: Ships with English and Simplified Chinese UI, default audio/subtitle language preferences, native UI scaling (90%–150%), and optional user `mpv.conf` overrides.

---

## Installation & Adding to Steam (SteamOS Guide)

PlayDeck is distributed as a self-contained single-file Flatpak bundle (`PlayDeck_<Version>_<CommitSHA>_<Release|Dev>_x86_64.flatpak`) with pinned builds of Electron, mpv, FFmpeg, and libplacebo.

### 1. Install the Runtime & Gamescope Vulkan Layer (One-Time Setup)

Switch your Steam Deck to **Desktop Mode**, open **Konsole** (or connect via SSH), and make sure the Flathub remote, the Freedesktop `25.08` runtime, and the **Gamescope Vulkan HDR layer extension** are installed:

```bash
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

flatpak install --user -y flathub \
  org.freedesktop.Platform//25.08 \
  org.freedesktop.Platform.GL.default//25.08 \
  org.freedesktop.Platform.GL.default//25.08-extra \
  org.freedesktop.Platform.VulkanLayer.gamescope//25.08
```

> **Important**: `org.freedesktop.Platform.VulkanLayer.gamescope//25.08` is required for sandboxed Flatpak apps to create an HDR10 Vulkan swapchain under SteamOS Gamescope. Without it, playback will fall back to SDR.

---

### 2. Download & Install the PlayDeck Flatpak

1. Download the latest `.flatpak` bundle from the [**Releases**](https://github.com/WheheoHu/playdeck/releases) page (or download a `dev` test artifact from **Actions → CI** and unzip it).
2. In a terminal, navigate to your download directory and install the bundle:

```bash
flatpak install --user -y ./PlayDeck_*_x86_64.flatpak
```

You can verify the installed package with:

```bash
flatpak info --user io.github.wheheohu.PlayDeck
```

---

### 3. Add PlayDeck to Steam (Required for Gaming Mode)

PlayDeck **must be launched through Steam in Gaming Mode** so that it runs inside `gamescope` with HDR compositing and dynamic panel refresh rate control.

#### Option A: Add via the Steam Desktop Client (Recommended)

1. In Steam Deck **Desktop Mode**, open **Steam**.
2. In the top menu bar, click **Games** → **Add a Non-Steam Game to My Library…**.
3. Check **PlayDeck** in the application list and click **Add Selected Programs**.
4. Locate **PlayDeck** in your Steam Library, right-click it → **Properties…** → **Shortcut**, and verify that Steam generated the following launch settings:
   - **Target**: `"/usr/bin/flatpak"`
   - **Launch Options**: `run --branch=master --arch=x86_64 --command=playdeck io.github.wheheohu.PlayDeck`
5. Return to **Gaming Mode** and launch **PlayDeck** from **Library → Non-Steam**.

#### Option B: Test Launch from a Terminal

To test the installation directly from a terminal:

```bash
flatpak run io.github.wheheohu.PlayDeck
```

---

### 4. Recommended Gaming Mode Settings

1. **Controller Layout (Steam Input)**
   - On PlayDeck's launch page in Gaming Mode, select the **Controller Settings** icon on the right.
   - Use the standard **Gamepad with Joystick Trackpad** template (default Xbox controller buttons; no keyboard remapping needed).
   - **Default Controls**:
     - **Browse UI**: `LB / RB` switch top tabs (or seasons on show pages), `A` select/play, `B` back (returns to Home from Libraries/Search, or opens the Quit prompt on Home), `X` context menu (mark watched/unwatched, play from beginning), `Y` sort library, `LT / RT` page up/down in grids, `Right Stick` scroll the subtitle list on detail pages, `☰` Settings.
     - **Playback OSD**: `A` pause/resume and show OSD (or confirm skip/next-episode prompts), `D-pad Left / Right` seek (hold to accelerate), `LB / RB` previous/next chapter, `Y` audio & subtitle tracks, `X` technical stats overlay (HDR/DV/bitrate/frame drops), `☰` playback menu (speed, A/V & subtitle delay, subtitle size, network monitor), press `B` twice to stop playback.

2. **HDR & External Display Resolution**
   - Press `•••` (Quick Access Menu) → **Performance / Display** and ensure **HDR** is enabled. While playing HDR10 or Dolby Vision content, an `HDR` badge will appear next to the QAM brightness slider.
   - When docked to an external 4K HDR TV or monitor, open PlayDeck's **Properties… → Shortcut → Game Resolution** in Steam and change it from `Default` to **`Native`** so Gamescope does not clamp the window to 1280×800.

---

## Updating, Configuration & Uninstalling

### Updating

Download the newer `.flatpak` bundle and reinstall over the existing installation (your account session and settings in `~/.config/PlayDeck` are preserved):

```bash
flatpak install --user -y --reinstall ./PlayDeck_*_x86_64.flatpak
```

You can check the running build version (`v<Version>_<CommitSHA>_<Dev|Release>`) at the top of the **Settings** (`☰`) overlay.

### Configuration & Custom `mpv.conf`

All user configuration lives in `~/.config/PlayDeck/`:
- `settings.json`: UI and playback settings (editable from the in-app Settings overlay or directly as JSON).
- `mpv.conf` (optional): If `~/.config/PlayDeck/mpv.conf` exists, PlayDeck automatically appends it via `--include` after its baseline flags on every playback session.

### Uninstalling

```bash
flatpak uninstall --user -y io.github.wheheohu.PlayDeck
```

---

## Development & Building

- **Branching & Versioning**:
  - `main`: Stable branch. Pushing a `v*` tag triggers `.github/workflows/release.yml` to build `PlayDeck_<Version>_<SHA>_Release_x86_64.flatpak` and publish a GitHub Release.
  - `dev`: Integration branch. Every push to `dev` triggers `.github/workflows/ci.yml` to run checks and upload a `PlayDeck_<Version>_<SHA>_Dev_x86_64.flatpak` build artifact.
  - `feature/*`, `bugfix/*`: Branched from `dev`, merged into `dev` for verification, then promoted to `main`.
- **Local Checks & App Build**:
  ```bash
  cd app
  npm ci
  npm run typecheck
  npm test
  npm run build
  ```
- **Build the Self-Contained Flatpak Bundle** (requires Linux `x86_64` with `flatpak-builder`):
  ```bash
  ./packaging/build-flatpak.sh
  ```

## License

PlayDeck is licensed under the **GPL-3.0-or-later**.
