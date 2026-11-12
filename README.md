# dsh-orange-cat 🐱

**DeepSeek Harness (DSH) 桌宠插件** —— 把一只真实感橘猫放进 DSH Web GUI 的右下角：
精灵图逐帧动画、点击表情、拖拽、双击曼波、以及 **AI 任务完成时的提示音**。

> 灵感与素材来自 [orange_cat 桌面宠物](https://github.com/jian-2023)（Win32 原生版），
> 本插件把同样的猫搬进了 DSH 的浏览器界面，无需常驻 Python 进程。

![icon](icon.svg)

## 功能

| 功能 | 说明 |
|---|---|
| 🎬 **动画** | 从视频逐帧抠像生成的精灵图，canvas 以 30fps 级别逐帧播放；静坐为主（74%），随机舔毛 / 玩耍，片段调度与原生版一致 |
| 🖱️ **单击** | 随机切换「惊讶 / 眯眼歪头」姿势，保持 0.7s 后回到原片段 |
| ⏬ **拖动** | 按住拖到任意位置，位置记在 localStorage，下次打开还在 |
| 🎵 **双击** | 播放「曼波」音效 + 歪头表情 |
| ☑️ **任务完成提示音** | AI 回答结束时播放 曼波 / 哈基米（各 1/2）+ 眨眼动画 + 气泡提示；带 1s 去抖 |
| 💬 **询问提醒** | 需要你确认时固定播放曼波（不受去抖影响） |
| 🔇 **右键菜单** | 静音 / 重置位置 / 隐藏 |

任务完成的侦测有两种通道（可同时启用）：

1. **浏览器内侦测**（默认开启）：包装 `window.fetch`，识别流式聊天响应结束 → 触发提示音；
2. **显式 HTTP 触发**：任何脚本都可以调用
   ```powershell
   # 任务完成（曼波/哈基米各 1/2，1s 去抖）
   Invoke-WebRequest "http://127.0.0.1:23216/orange-cat/notify?kind=done"
   # 需要确认/选择（固定曼波，不去抖）
   Invoke-WebRequest "http://127.0.0.1:23216/orange-cat/notify?kind=ask"
   ```
   通知通过 SSE（`/orange-cat/events`）广播到所有打开的 GUI 标签页。
   也可以在控制台里调 `window.__orangeCat.notify('done')`。

> 浏览器的自动播放策略会拦住「用户还没点过页面」的音效——点一下猫（或页面任意处）
> 即解锁；被拦截时猫会弹气泡提示。

## 安装

### 方式一：DSH 插件市场 / CLI（推荐）

```powershell
# 在 DSH 的插件管理里安装本地包
dsh plugin install link:<本仓库克隆路径>
```

或在 DSH 设置 → 插件 里选择从本地路径安装。

### 方式二：手动

```powershell
git clone https://github.com/jian-2023/dsh-orange-cat.git
```

然后在 DSH 的插件管理 UI 里以 `link:<克隆路径>` 安装，重启 DSH 即可看到右下角的猫。

### 卸载 / 关闭

插件管理里移除即可；或把配置里 `enabled` 改为 `false`。

## 配置

`cordis.patch.yml` 里的 `config` 全部可改：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `size` | `150` | 猫画布边长（px） |
| `marginX` / `marginY` | `28` | 初始贴边距离 |
| `volume` | `0.8` | 提示音音量 0..1 |
| `doneSounds` | `['manbo.wav','hjm.wav']` | 任务完成音效（随机） |
| `askSounds` | `['manbo.wav']` | 询问提醒音效 |
| `taskDoneWatch` | `true` | 浏览器内侦测回答结束 |
| `weights` | 静坐 0.74 / 舔毛 0.16 / 眨眼 0.05 / 玩耍 0.05 | 片段权重 |
| `sitHoldSec` | `25` | 静坐保持秒数 |
| `poseHoldMs` | `700` | 单击姿势保持毫秒 |

## 素材说明

- `media/sheet_*.png`：由 5 段 AI 生成的绿幕视频逐帧抠像、按整段包围盒归一化后
  打包成的精灵图（导出脚本见源项目的 `tools/export_web_sprites.py`）；
- `media/*.wav`：曼波 / 哈基米提示音（winsound 兼容 WAV，浏览器可直接播放）；
- 猫的原始视频素材为 AI 生成（绿幕、固定机位）。

## 目录结构

```
package.json        DSH 插件清单（dsh.bundle.patch）
cordis.patch.yml    插入行 + 默认配置
lib/index.js        服务端：媒体路由 / SSE / notify 端点 / index 注入
media/              精灵图 + manifest.json + 音效
locale/             zh / en 文案
icon.svg            橘猫图标
```

## 兼容性

- 需要 Windows 版 DeepSeek Harness（Web GUI）；
- 插件只注入 DSH 自己的页面，不影响其他网站；
- 猫窗口 z-index 极高、可拖动，不遮挡输入框时建议放在右下角。

## License

MIT © 2026 jian-2023
