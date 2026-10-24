# PlayDeck

PlayDeck 是一款专为 **Steam Deck OLED（SteamOS Gaming Mode / gamescope）** 设计的全手柄 10-foot Plex 客户端，支持 **90 fps 流畅海报墙浏览** 与 **原生 HDR10 / 杜比视界（Dolby Vision）Direct Play 播放**。

## 功能概览

- **原生 HDR10 与杜比视界输出**：基于内置 `mpv`（`vo=gpu-next` / Vulkan / `libplacebo`）与 Gamescope WSI Vulkan 层直通 PQ/BT.2020 信号及静态元数据，支持 HDR10、HDR10+ 与 Dolby Vision（Profile 5 / 8.1 / 8.4）RPU 重塑与硬件解码（VA-API）。
- **屏幕刷新率自动匹配**：通过 `gamescope_control` 协议在播放开始前自动将 Steam Deck OLED 面板切换为片源帧率的整数倍（23.976/24p → 72 Hz、25p → 50 Hz、29.97/30p → 90 Hz、59.94/60p → 60 Hz），退出播放后自动恢复 90 Hz。
- **90 fps 全手柄浏览界面**：支持扫码/短码登录、Plex Home 多用户（含 PIN）、多服务器自动测速选路（LAN 优先）、跨服合并首页、虚拟化海报网格、剧集分集浏览与详细媒体流信息查看。
- **手柄专属播放 OSD**：内置音轨与内嵌/外挂字幕切换、片头/片尾跳过、下一集倒计时连播、播放倍速/音画同步/字幕缩放、HDR 字幕与 OSD 亮度调节（基准 203 nits）以及实时网络加载速率监控。
- **多语言与自定义**：内置简体中文与英文界面，支持默认音轨/字幕语言偏好、界面缩放（90%–150%）以及自定义 `mpv.conf` 覆盖。

---

## 安装与添加到 Steam（SteamOS 指南）

PlayDeck 以自包含单文件 Flatpak 包（`PlayDeck_<版本号>_<CommitSHA>_<Release|Dev>_x86_64.flatpak`）分发，内置固定版本的 Electron、mpv、FFmpeg 与 libplacebo。

### 1. 准备运行时环境（首次安装执行一次）

切换到 Steam Deck **桌面模式（Desktop Mode）** 打开 **Konsole** 终端（或通过 SSH 连接 Deck），确保已添加 Flathub 源并安装 Freedesktop `25.08` 运行时与 **Gamescope Vulkan HDR 层扩展**：

```bash
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

flatpak install --user -y flathub \
  org.freedesktop.Platform//25.08 \
  org.freedesktop.Platform.GL.default//25.08 \
  org.freedesktop.Platform.GL.default//25.08-extra \
  org.freedesktop.Platform.VulkanLayer.gamescope//25.08
```

> **重要说明**：`org.freedesktop.Platform.VulkanLayer.gamescope//25.08` 是 Flatpak 沙箱内应用向 SteamOS Gamescope 创建 HDR10 交换链的必需扩展；缺少该扩展将导致视频退回 SDR 渲染。

---

### 2. 下载并安装 PlayDeck Flatpak

1. 前往本仓库的 [**Releases**](https://github.com/WheheoHu/playdeck/releases) 页面下载最新正式版 `.flatpak` 文件（或在 **Actions → CI** 中下载 `dev` 分支构建的测试 Artifact 并解压出 `.flatpak` 文件）。
2. 在终端中进入下载目录并执行安装：

```bash
flatpak install --user -y ./PlayDeck_*_x86_64.flatpak
```

安装完成后，可以通过以下命令验证版本信息：

```bash
flatpak info --user io.github.wheheohu.PlayDeck
```

---

### 3. 添加到 Steam（以便在 Gaming Mode 中启动）

PlayDeck **必须通过 Steam 在 Gaming Mode（游戏模式）下启动**，才能接入 Gamescope 的 HDR 合成管道与面板动态刷新率控制。

#### 方法一：在桌面模式 Steam 客户端中添加（推荐）

1. 在 Steam Deck 桌面模式中打开 **Steam** 客户端。
2. 点击顶部菜单栏 **游戏（Games）** → **添加非 Steam 游戏到我的库中…（Add a Non-Steam Game to My Library…）**。
3. 在应用列表中勾选 **PlayDeck**，点击底部的 **添加所选程序（Add Selected Programs）**。
4. 在 Steam 库中找到 **PlayDeck**，右键打开 **属性（Properties）** → **快捷方式（Shortcut）**，确认其启动参数如下（Steam 会自动生成，通常无需手动修改）：
   - **目标（Target）**：`"/usr/bin/flatpak"`
   - **启动选项（Launch Options）**：`run --branch=master --arch=x86_64 --command=playdeck io.github.wheheohu.PlayDeck`
5. 返回 **Gaming Mode（游戏模式）**，即可在 **库 → 非 Steam（Non-Steam）** 中启动 PlayDeck。

#### 方法二：使用 Steam 命令行直接拉起测试

如果已在桌面模式添加了快捷方式，也可以通过终端或 SSH 在 Gaming Mode 中直接运行。若仅需临时在终端验证安装，可执行：

```bash
flatpak run io.github.wheheohu.PlayDeck
```

---

### 4. Gaming Mode 手柄与显示配置建议

1. **手柄布局（Steam Input）**
   - 在 Gaming Mode 的 PlayDeck 启动页点击右侧 **手柄图标（控制器设置）**。
   - 将当前布局选为官方模板 **手柄（带摇杆触控板）/ Gamepad with Joystick Trackpad**（默认即为标准 Xbox 手柄键位，无需额外映射键盘按键）。
   - **常用按键说明**：
     - **浏览界面**：`LB / RB` 切换顶部标签页，`A` 确认/播放，`B` 返回（在库/搜索页返回首页，在首页弹出退出确认），`X` 打开上下文菜单（标记已看/从头播放），`Y` 媒体库排序，`LT / RT` 网格翻页，右摇杆上下翻页浏览详情页字幕列表，`☰` 打开设置。
     - **播放界面**：`A` 暂停/继续并唤出 OSD（当出现跳过片头/下一集卡片时为确认），`左右方向键` 快退/快进（长按加速），`LB / RB` 上一章/下一章，`Y` 音轨与字幕菜单，`X` 统计信息（HDR/DV/码率/掉帧），`☰` 播放菜单（倍速/延迟/字幕大小/网络监控），连按两次 `B` 停止播放。

2. **HDR 与分辨率设置**
   - 按 `•••`（快捷访问菜单 QAM）→ **性能 / 显示**，确保系统 **HDR** 已开启；播放 HDR10 或杜比视界影片时，QAM 亮度滑块旁会显示 `HDR` 标识。
   - 若连接外接 4K HDR 显示器/电视，请在 Steam 的 PlayDeck **属性 → 快捷方式 → 游戏分辨率（Game Resolution）** 中将默认的 `Default` 改为 **`Native`（原生）**，以免被 Gamescope 限制在 1280×800。

---

## 更新、配置与卸载

### 更新版本

下载新版本的 `.flatpak` 包后，直接覆盖安装即可（账号登录态与设置保存在 `~/.config/PlayDeck`，不会丢失）：

```bash
flatpak install --user -y --reinstall ./PlayDeck_*_x86_64.flatpak
```

可以在应用内按 `☰` 打开 **设置**，顶部账号信息右侧会显示当前运行的完整构建版本号（格式：`v版本号_CommitSHA_Dev/Release`）。

### 配置文件与自定义 `mpv.conf`

PlayDeck 的所有配置文件均存放在 `~/.config/PlayDeck/`：
- `settings.json`：界面与播放偏好设置（支持在 UI 中修改或直接编辑 JSON）。
- `mpv.conf`（可选）：若存在 `~/.config/PlayDeck/mpv.conf`，每次启动 `mpv` 时会在末尾自动通过 `--include` 加载，可用于追加高阶自定义参数。

### 卸载

```bash
flatpak uninstall --user -y io.github.wheheohu.PlayDeck
```

---

## 开发与构建

- **分支与版本规范**：
  - `main`：稳定可用分支；推送 `v*` 标签时自动触发 `.github/workflows/release.yml` 构建 `PlayDeck_<Version>_<SHA>_Release_x86_64.flatpak` 并发布 GitHub Release。
  - `dev`：集成开发分支；每次推送到 `dev` 时自动触发 `.github/workflows/ci.yml` 检查并产出 `PlayDeck_<Version>_<SHA>_Dev_x86_64.flatpak` 测试 Artifact。
  - `feature/*`、`bugfix/*`：功能与修复分支，合并进 `dev` 验证后再合入 `main`。
- **本地验证与构建**：
  ```bash
  cd app
  npm ci
  npm run typecheck
  npm test
  npm run build
  ```
- **构建 Flatpak 单文件包**（需 Linux `x86_64` 环境及 `flatpak-builder`）：
  ```bash
  ./packaging/build-flatpak.sh
  ```

## 许可证

本项目基于 **GPL-3.0-or-later** 许可证开源。
