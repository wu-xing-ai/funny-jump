# 部署与打包指南

> 本篇是 [趣味游戏](.) 的详细部署教程。只想玩游戏的话，看 README 就够了。

## 文件说明

| 文件 | 作用 | 必须上传？ |
|---|---|---|
| `index.html` | 游戏本体（含本地排行榜） | ✅ 必须 |
| `config.js` | 配置：玩家名单、云端接口地址 | ✅ 建议 |
| `worker/` 目录（worker.js + wrangler.toml） | 云端排行榜服务，KV 已配置并部署上线 | 改动后需 cd worker && wrangler deploy |

---

## 一、排行榜的两种模式

- **本地模式**：`config.js` 里 `LEADERBOARD_API` 留空 `''`。记录只存在每个玩家自己的浏览器里，谁也看不到谁的。
- **云端模式（全服共享）**：填上 Worker 地址后，所有人的成绩汇总到同一个榜单。
- **智能切换（已内置）**：
  - 提交成绩时：先存本机 → 再传云端；断网时自动进离线队列，恢复联网自动补传
  - 查看榜单时：先秒开本地 → 有网就拉云端合并去重
  - 所以不管在线离线，游戏都能正常玩、正常记录

---

## 二、发布静态页面（Cloudflare Pages）

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → 左侧 **Workers 和 Pages** → **创建** → 选 **Pages** 标签 → **直接上传**
2. 项目名随便取（比如 `quwei-game`），把 `index.html` 和 `config.js` 拖进去 → 部署
3. 完成后会得到 `https://quwei-game.pages.dev` 这样的网址，发给朋友就能玩

到这里就是本地排行榜模式。想全服共享，继续第三步。

---

## 三、云端排行榜（已完成部署）

Worker 和 KV 已经创建并绑定完毕：

- 接口地址已写入 `config.js` 的 `LEADERBOARD_API`（形如 `https://quwei-game-lb.xxx.workers.dev`）
- Worker 源码：`worker/worker.js`
- Worker 配置：`worker/wrangler.toml`（KV 命名空间 id 已填好）

游戏内置混合模式：有网时成绩自动传云端并拉取全服榜单；断网时存本地队列，恢复联网自动补传，无需任何手动操作。

### 以后想更新 Worker

修改 `worker/worker.js` 后执行：

```bash
cd worker
wrangler deploy
```

### 管理云端榜单（清空记录）

在 `worker/wrangler.toml` 里加上管理密码后重新部署：

```toml
[vars]
ADMIN_KEY = "你的密码"
```

浏览器访问 `https://你的worker地址/admin/clear?key=你的密码` 即可清空云端记录。

> 免费额度完全够用：KV 每天 10 万次读 / 1000 次写。

---

## 四、推送到 GitHub，每次 push 自动部署

### 方式 A：Cloudflare 关联仓库（最省事，推荐）

1. dash.cloudflare.com → Workers 和 Pages → 创建 → Pages → **连接到 Git**
2. 授权 GitHub → 选中本仓库
3. 构建命令留空，输出目录填 `.`，保存部署
4. 以后每次 `git push`，Cloudflare 自动拉取并发布，无需任何操作

### 方式 B：GitHub Actions 自动部署（工作流已内置）

仓库里自带 `.github/workflows/deploy.yml`，只需给仓库配两个机密：
Settings → Secrets and variables → Actions → New repository secret

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com/profile/api-tokens 创建，用「编辑 Cloudflare Workers」模板并追加 Pages:Edit 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 控制台右侧栏 / Workers 和 Pages 概览页 |

之后每次 push 到 `main` 分支自动部署，也可在 Actions 页面手动触发。

> 方式 A 和方式 B 二选一即可；用 A 的话可以删掉 `deploy.yml`。

---

## 五、以后打包成三平台 App（重要提醒）

**Electron 只能打包电脑软件**（Windows / macOS / Linux），**做不了 iOS 和安卓 App**。

推荐方案（一套代码全平台通用）：

| 平台 | 工具 | 说明 |
|---|---|---|
| Windows | Electron 或 Tauri | 直接加载 index.html，出 .exe 安装包 |
| 安卓 | Capacitor | 包成原生 App，出 .apk（可直接发给别人装） |
| iOS | Capacitor | 需要 Mac + Xcode + 苹果开发者账号（$99/年） |

Capacitor 大致流程：

```bash
npm init -y
npm install @capacitor/core @capacitor/cli
npx cap init 趣味游戏 com.example.fungame --web-dir=.
npx cap add android      # 安卓
npx cap add ios          # iOS（需要 Mac）
npx cap open android     # 用 Android Studio 打开出 apk
npx cap open ios         # 用 Xcode 打开出 ipa
```

注意事项：

- iOS 上架 App Store 需要苹果开发者账号（99 美元/年）；安卓国内分发可以直接发 .apk 文件
- 排行榜在 App 里照样能用：本地榜天然支持，云端榜走同一个 Worker 地址即可
