# SwarmPath Agent Bridge

将 Claude Agent SDK 的完整终端能力通过 HTTP/SSE 暴露给 Web 前端，支持 **Electron / Tauri 双模式桌面应用** 一键运行，内置 Evolution Engine 自进化系统。

## 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│              Desktop App (Electron .dmg 或 Tauri .dmg)               │
│  ┌──────────────────┐     SSE      ┌────────────────────┐    SDK    │
│  │   WebView/Window  │ ◄──────────► │  Agent Bridge API  │ ◄──────► │ Claude Agent SDK
│  │  (单文件 HTML)    │  /api/stream │  (Fastify :3300)   │  query() │
│  └──────────────────┘              └────────────────────┘           │
│                                         │                           │
│                                  Session Manager + Evolution Engine  │
│                                  (文件持久化 + 自进化 + Instinct 学习) │
└──────────────────────────────────────────────────────────────────────┘
```

### 双模式桌面架构

| | Electron | Tauri |
|---|---------|-------|
| **渲染引擎** | Chromium (内置) | 系统 WebView (macOS WebKit) |
| **服务器运行** | In-process (直接 import) | Sidecar (bun 编译的独立二进制) |
| **DMG 体积** | ~132 MB | **~57 MB** |
| **打包命令** | `npm run electron:build` | `npm run tauri:build` |

```
Electron: electron/main.js → import server.js → BrowserWindow
Tauri:    src-tauri/main.rs → spawn sidecar → WebView
```

### 三区架构

| Zone | 目录 | Git | 说明 |
|------|------|-----|------|
| **1 源码** | `src/` | tracked | TypeScript 源文件 |
| **2 知识** | `knowledge/` | tracked | skills, commands, agents, rules, memory, contexts, hooks |
| **3 数据** | `data/` | ignored | config, sessions, evolution, teams, tasks, uploads, sdk-cache |

```
swarmpath-agent-bridge/
├── src/                          # Zone 1: 源码
│   ├── index.ts                  # 入口 (端口 3300)
│   ├── server.ts                 # Fastify 服务, Memory/MCP/Config API, Live Reload
│   ├── types.ts                  # 全类型定义
│   ├── routes/
│   │   ├── stream.routes.ts      # SSE 流式查询 + 权限 Hook + 观察日志
│   │   ├── session.routes.ts     # 会话 CRUD + Skill 管理 + 渠道测试 API
│   │   ├── evolution.routes.ts   # Evolution Engine + Cron + Heartbeat + Webhook + Exec
│   │   └── knowledge.routes.ts   # 知识内容 CRUD API
│   ├── services/
│   │   ├── sdk-bridge.ts         # SDK 封装 + 模型渠道路由 + 可执行路径解析
│   │   ├── session-manager.ts    # 路径常量 + 会话持久化 + 数据生命周期 + SDK CLI 定位
│   │   ├── evolution-engine.ts   # 自进化引擎 + Instinct 提取
│   │   ├── background-exec.ts    # 后台命令执行
│   │   └── lane-queue.ts         # 并发队列
│   └── utils/
│       └── message-transform.ts  # Raw SDK → SSE Event 转换
├── web/
│   └── index.html                # 全功能 Web 终端 UI (单文件)
├── electron/                     # Electron 桌面应用
│   ├── main.js                   # 主进程 (服务器 in-process + PATH 恢复)
│   ├── preload.js                # 预加载脚本
│   ├── loading.html              # 启动加载页 (Catppuccin 主题)
│   ├── icon.icns                 # macOS 应用图标
│   ├── icon.png                  # 通用图标 (512×512)
│   └── icon-tray.png             # 系统托盘图标 (18×18)
├── knowledge/                    # Zone 2: 知识内容 (ECC 集成)
│   ├── .claude/
│   │   ├── skills/ (70+)         # 技能库 (来自 everything-claude-code)
│   │   └── commands/ (34+)       # 聊天命令
│   ├── agents/ (10)              # 子代理定义
│   ├── rules/ (29)               # 编码规则 (common/ts/py/go/swift)
│   ├── memory/                   # 项目记忆 (CLAUDE/KNOWLEDGE/SOUL/IDENTITY/STYLE/USER)
│   ├── contexts/ (3)             # 上下文预设 (dev/research/review)
│   ├── hooks/                    # 工具钩子定义
│   └── mcp-configs/              # MCP 服务器配置模板
├── data/                         # Zone 3: 运行时数据 (gitignored)
│   ├── config/                   # server-config.json, mcp-servers.json, model-channels.json
│   ├── sessions/                 # 会话 JSON + 前端消息备份 (.messages.json)
│   ├── evolution/                # findings, metrics, proposals, instincts, observations
│   ├── teams/                    # Agent 团队 (固定资产, 不随会话删除)
│   ├── tasks/                    # 任务追踪 (临时, 随会话删除)
│   ├── uploads/                  # 附件存储
│   └── sdk-cache/                # SDK 自动生成
├── src-tauri/                     # Tauri 桌面应用 (Rust)
│   ├── src/main.rs               # 主进程 (sidecar 启动 + 健康检查 + 托盘)
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置
│   ├── capabilities/             # 权限配置
│   ├── icons/                    # 应用图标
│   ├── binaries/                 # sidecar 二进制 (bun compile, gitignored)
│   └── sdk-assets/               # SDK 原生文件 (cli.js + vendor, gitignored)
├── release/                      # Electron 打包输出 (gitignored)
├── dist/                         # tsc 编译输出
├── package.json
├── tsconfig.json
└── .env
```

## 版本历史

| 版本 | 核心改动 |
|------|---------|
| **v3.2** (当前) | **消息服务端持久化** (重装 app 不丢消息) + 资源管理器文件删除 + AI 自动感知删除 + 文件卡片延迟渲染 (流式完成后) + 多文件截图卡片修复 + 模型标签精简 + 生成文件强制保存到工作目录 |
| **v3.1** | **Tauri 桌面应用** (57MB, 体积缩小 57%) + Electron/Tauri 双打包模式 + bun sidecar 编译 + 文件卡片提取全面重写 |
| **v3.0** | **Electron 桌面应用** (.dmg/.zip) + 动态模型列表 + 渠道预设 (Anthropic/DeepSeek/Qwen/MiniMax/OpenRouter) + 连接测试 + 原生文件夹浏览 + 全新安装引导 |
| **v2.2** | VS Code 风格文件资源管理器 + 统一模型渠道管理 + 文件预览系统 + .env 配置 UI |
| **v2.1** | 三区架构 + ECC 知识集成 + Evolution Engine v2 (Instinct 学习) + 数据生命周期管理 |
| **v2.0** | 会话导出 (PNG/MD) + 主题切换 + 博弈引擎增强 (Iron Rules) + 报告卡片渲染 |
| **v1.2** | MCP 服务器管理 + Skill 系统 + Plan-First 审批 |
| **v1.1** | Agent Teams + P2P 可视化 + 博弈引擎 v2.0 Phase Toolkit + 三层记忆 |
| **v1.0** | 基础架构: 多会话 + SSE 流式 + 授权目录 + 附件上传 + 主题系统 |

## 核心能力

| 能力 | 说明 |
|------|------|
| **双模式桌面应用** | Electron (132MB) 或 Tauri (57MB) 两种打包方式，双击运行；macOS .dmg 安装，支持系统托盘常驻 |
| **动态模型管理** | 模型列表从配置的渠道动态获取，支持自动发现和手动添加 |
| **渠道预设** | 内置 Anthropic、DeepSeek、阿里云 Qwen、MiniMax、OpenRouter 预设，自动填充 Base URL |
| **连接测试** | 一键测试 API 连接，自动拉取可用模型列表 (通过 `/v1/models` 端点) |
| **原生文件夹浏览** | macOS 原生文件夹选择对话框，替代手动输入路径 |
| **消息持久化** | 前端消息同步保存到服务端文件，重装 app 后自动恢复聊天记录 (localStorage + 服务端双写) |
| **会话连续性** | SDK session ID 自动追踪，`resume` 恢复上下文 |
| **流式输出** | SSE 实时推送 text/thinking/tool_use/tool_result |
| **全工具支持** | Read, Edit, Write, Bash, Glob, Grep, WebSearch 等 |
| **权限控制** | PreToolUse hook 目录级写权限 + Bash 命令安全过滤 |
| **Agent Teams** | 多智能体协作 + 委派模式 + SDK 原生 Hooks + P2P 通信可视化 |
| **博弈引擎 v2.0** | Phase Toolkit 自适应协议, 10 种预设 + AI 自主编排 |
| **Evolution Engine** | 指标追踪 + 发现系统 + 自反思 + Instinct 学习 + CronJob + 心跳 + Webhook |
| **Instinct 学习** | 工具调用观察 → JSONL 日志 → 模式检测 → 规则化 Instinct 提取 (零 LLM 成本) |
| **三层记忆** | 身份层(CLAUDE.md) + 知识层(KNOWLEDGE.md) + 会话层(临时) |
| **知识库** | ECC 集成: 70+ Skills, 34+ Commands, 10 Agents, 29 Rules, 3 Contexts |
| **数据生命周期** | 固定资产 (Teams/Knowledge/Evolution) vs 临时数据 (Tasks/Uploads/Sessions) |
| **文件资源管理器** | VS Code 风格侧边栏文件树，SVG Seti 图标，目录展开/折叠，点击预览，hover 删除按钮 + AI 自动感知 |
| **文件预览系统** | HTML 渲染/源码双模式，Markdown 渲染，PDF iframe，图片预览+灯箱，代码语法高亮 |
| **模型渠道管理** | 统一 UI 管理多 AI 供应商，卡片式渠道列表+编辑弹窗+预设选择 |
| **.env 配置 UI** | 前端可视化编辑运行时环境变量 (端口/模型/权限/超时等) |
| **MCP 服务器** | 设置面板管理 MCP 扩展工具，自然语言安装 |
| **Skill 系统** | 全局/项目级 Skill 安装，基于 SKILL.md 文件协议 |
| **会话导出** | PNG 截图 (html2canvas+样式烘焙) + Markdown 导出 |
| **Live Reload** | WebSocket + fs.watch, 编辑 web/ 自动刷新浏览器 (开发模式) |

## 快速开始

### 方式一：桌面应用 (推荐)

1. 下载最新 `.dmg` 文件 (在 [Releases](../../releases) 页面)
2. 打开 DMG，将 **SwarmPath Agent Bridge** 拖入 Applications
3. 双击启动应用
4. 首次启动会自动引导添加模型渠道:
   - 选择预设供应商 (如 Anthropic)
   - 填入 API Key
   - 点击"测试连接 & 获取模型"验证
   - 保存后即可开始使用

桌面应用数据存储在 `~/Library/Application Support/SwarmPath Agent Bridge/data/`。

### 方式二：命令行启动

```bash
git clone <repo-url>
cd swarmpath-agent-bridge
cp .env.example .env
# 编辑 .env 填入 ANTHROPIC_API_KEY

npm install
npm run build
node dist/index.js
```

服务启动在 `http://localhost:3300`。

### 方式三：开发模式

```bash
npm run dev          # tsx watch 热重载
npm run electron:dev # Electron 开发模式
npm run tauri:dev    # Tauri 开发模式
```

## 桌面应用打包

支持 Electron 和 Tauri 两种打包方式，共存于同一项目，互不干扰。

### 对比

| | Electron | Tauri (推荐) |
|---|---------|-------------|
| **DMG 体积** | 132 MB | **57 MB** (-57%) |
| **安装后体积** | 344 MB | **158 MB** (-54%) |
| **渲染引擎** | Chromium (内置) | 系统 WebView (macOS WebKit) |
| **服务器运行** | In-process import | Sidecar 独立二进制 (bun compile) |
| **打包命令** | `npm run electron:build` | `npm run tauri:build` |
| **输出目录** | `release/` | `src-tauri/target/release/bundle/` |
| **环境要求** | Node.js >= 18 | Node.js >= 18 + Rust + Bun |

### Tauri 打包 (推荐)

```bash
# 环境准备 (首次)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # 安装 Rust
npm install -g bun                                                  # 安装 Bun

# 一键打包
npm run tauri:build
```

输出文件:
```
src-tauri/target/release/bundle/
├── dmg/SwarmPath Agent Bridge_2.0.0_aarch64.dmg    (57 MB)
└── macos/SwarmPath Agent Bridge.app                 (158 MB)
```

构建流程: `tsc` → `bun build --compile` (sidecar 二进制 59MB) → `cargo build` (Tauri 壳 8MB) → `.dmg`

### Electron 打包

```bash
npm run electron:build
```

输出文件:
```
release/
├── SwarmPath Agent Bridge-2.0.0-arm64.dmg           (132 MB)
├── SwarmPath Agent Bridge-2.0.0-arm64-mac.zip
└── mac-arm64/SwarmPath Agent Bridge.app              (344 MB)
```

### 技术细节

| 特性 | Electron | Tauri |
|------|----------|-------|
| **服务器启动** | `import()` server.js in-process | `spawn` sidecar 二进制 (bun compile) |
| **PATH 恢复** | JS: `execSync('/bin/zsh -ilc ...')` | Rust: `Command::new("/bin/zsh")` |
| **SDK CLI 定位** | `createRequire()` 解析 node_modules | `sdk-assets/cli.js` (资源目录) |
| **健康检查** | 加载页 → 轮询 `/health` | Rust 异步轮询 → 窗口显示 |
| **窗口行为** | macOS hide-on-close + 托盘 | 相同 |
| **Live Reload** | 检测 `ELECTRON=1` 禁用 | 相同 |

### 打包包含的文件

```
Electron:                          Tauri:
├── dist/          编译后 JS       ├── sidecar 二进制     (bun compile, ~59MB)
├── web/           前端 HTML       ├── web/               前端 HTML
├── knowledge/     知识库          ├── knowledge/         知识库
├── electron/      主进程+图标     ├── sdk-assets/        SDK 原生文件
├── node_modules/  所有依赖        └── Tauri 壳           (~8MB Rust 二进制)
├── .env           配置
└── package.json
```

## 模型渠道管理

统一管理所有 AI 模型供应商的 API 凭证，支持动态模型发现。

### 内置预设

| 预设 | Base URL | 说明 |
|------|---------|------|
| **Anthropic 官方** | `https://api.anthropic.com` | Claude 系列模型 |
| **DeepSeek** | `https://api.deepseek.com/anthropic` | DeepSeek 系列 (Anthropic 兼容) |
| **阿里云 Qwen** | `https://dashscope.aliyuncs.com/apps/anthropic` | 通义千问系列 (Anthropic 兼容) |
| **MiniMax** | `https://api.minimaxi.com/anthropic` | MiniMax 系列 (Anthropic 兼容) |
| **OpenRouter** | `https://openrouter.ai/api` | 多模型聚合平台 |
| **自定义代理** | (用户填入) | 自建代理或其他兼容 API |

### 添加渠道流程

1. 设置面板 → 模型渠道 → 添加渠道 (或模型下拉框底部 "+ 添加模型渠道")
2. 选择预设供应商 → Base URL 自动填入 (也可手动修改)
3. 填入 API Key
4. 点击 **"🔗 测试连接 & 获取模型"** → 自动调用 `/v1/models` 端点
5. 连接成功后模型列表自动填入
6. 保存渠道 → 模型下拉框即时更新

### 渠道类型

| 渠道 | 存储位置 | 说明 |
|------|---------|------|
| **默认 (Anthropic)** | `.env` | ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL |
| **自定义渠道** | `data/config/model-channels.json` | 各供应商独立配置 |

### 运行机制

```
用户选择模型 → resolveModelChannel(model) → 查找匹配的 enabled 渠道
  ├─ 找到 → 注入 apiKey + baseUrl 到 SDK 环境变量
  └─ 未找到 → 回退到 .env 默认 Anthropic 凭证
```

### 首次安装引导

全新安装 (无 `.env` 配置) 时，应用自动检测模型列表为空，弹出渠道编辑器引导用户完成首个 API 渠道配置。

## Evolution Engine

自进化系统，持续监控和优化 Bridge 运行状态。

### 观察 → Instinct 管线

```
工具调用 ──PreToolUse Hook──► JSONL 观察日志 (data/evolution/observations/)
                                      │
                              ┌───────┴────────┐
                              │  会话关闭聚合    │ → Evolution Finding
                              └───────┬────────┘
                                      │
                              ┌───────┴────────┐
                              │  定时提取 (2h)   │ → Instinct Index
                              └────────────────┘
                                      │
                              data/evolution/instincts/index.json
```

### Instinct 提取规则

| 规则 | 触发条件 | Instinct ID |
|------|---------|-------------|
| 频繁拒绝 | 同一工具被拒绝 ≥3 次 | `deny-pattern-{tool}` |
| 频繁错误 | 同一工具出错 ≥3 次 | `error-pattern-{tool}` |
| 使用偏好 | 统计 Top 3 工具 | `tool-preference` |
| 高拒绝率 | 拒绝率 >10% | `high-deny-rate` |

每个 Instinct 带 confidence (0.3-0.9), 在 Evo 面板中可视化展示。

### 定时任务

| 任务 | 间隔 | 功能 |
|------|------|------|
| metrics-digest | 6h | 指标聚合分析 |
| health-check | 5min | 内存/进程健康检查 |
| code-health | 24h | 代码质量扫描 |
| instinct-extraction | 2h | Instinct 模式提取 |

### 数据生命周期

| 数据 | 类型 | 会话关闭 | 启动清理 | 手动清理 |
|------|------|---------|---------|---------|
| Teams | **固定资产** | 保留 | 保留 | `POST /api/cleanup` |
| Knowledge/Memory | **固定资产** | 保留 | 保留 | 不删 |
| Evolution (instincts/findings) | **固定资产** | 保留 | 保留 | 不删 |
| Tasks | 临时 | 删除 | 清孤儿 | 删除 |
| Uploads | 临时 | 删除 | 清孤儿 | — |
| Session files | 临时 | 删除 | — | — |
| Messages (前端备份) | 临时 | 随会话删除 | 清孤儿 | — |
| Observations (JSONL) | 临时 | 聚合后删除 | >7 天自动清理 | — |

## API 接口

### 会话管理

```bash
# 创建会话
curl -X POST http://localhost:3300/api/session \
  -H 'Content-Type: application/json' \
  -d '{"name": "dev", "cwd": "/path/to/project"}'

# 列出 / 更新 / 清除上下文 / 关闭会话
curl http://localhost:3300/api/session
curl -X PATCH http://localhost:3300/api/session/{id} -H 'Content-Type: application/json' -d '{...}'
curl -X POST http://localhost:3300/api/session/{id}/clear
curl -X DELETE http://localhost:3300/api/session/{id}

# 前端消息持久化 (服务端备份)
curl http://localhost:3300/api/session/{id}/messages                           # 读取消息
curl -X PUT http://localhost:3300/api/session/{id}/messages \
  -H 'Content-Type: application/json' -d '{"messages":[...]}'                 # 保存消息
```

### 流式查询 (SSE)

```bash
curl -N -X POST http://localhost:3300/api/stream \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "xxx", "prompt": "Read package.json and summarize"}'
```

### 模型渠道

```bash
# 渠道列表 (API Key 脱敏)
curl http://localhost:3300/api/model-channels

# 添加渠道
curl -X POST http://localhost:3300/api/model-channels \
  -H 'Content-Type: application/json' \
  -d '{"id":"deepseek","name":"DeepSeek","apiKey":"sk-...","baseUrl":"https://api.deepseek.com","models":["deepseek-chat"],"enabled":true}'

# 更新 / 删除渠道
curl -X PATCH http://localhost:3300/api/model-channels/deepseek \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -X DELETE http://localhost:3300/api/model-channels/deepseek

# 测试连接 & 获取模型
curl -X POST http://localhost:3300/api/test-channel \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-...","baseUrl":"https://api.anthropic.com"}'
```

### 文件浏览

```bash
curl http://localhost:3300/api/tree/{sessionId}?depth=4                    # 获取文件树
curl http://localhost:3300/api/file-content/{sessionId}?path=src/index.ts  # 获取文件内容 (文本)
curl http://localhost:3300/api/files/{sessionId}?path=logo.png             # 获取原始文件 (二进制)
curl -X DELETE http://localhost:3300/api/files/{sessionId}?path=file.png   # 删除文件 (限会话 CWD 内)
curl http://localhost:3300/api/browse-directory                            # 原生文件夹选择对话框 (macOS)
```

### Evolution Engine

```bash
curl http://localhost:3300/api/evolution/status       # 运行状态
curl http://localhost:3300/api/evolution/metrics       # 查询指标
curl http://localhost:3300/api/evolution/findings      # 发现列表
curl http://localhost:3300/api/evolution/proposals     # 规则提案
curl http://localhost:3300/api/evolution/instincts     # 学习到的 Instincts
```

### 知识库

```bash
curl http://localhost:3300/api/knowledge/stats         # 总览统计
curl http://localhost:3300/api/knowledge/agents         # 代理列表
curl http://localhost:3300/api/knowledge/rules          # 规则列表
curl http://localhost:3300/api/knowledge/contexts       # 上下文预设
```

### 环境变量

```bash
curl http://localhost:3300/api/env                                         # 读取 .env 配置
curl -X PUT http://localhost:3300/api/env \
  -H 'Content-Type: application/json' -d '{"entries":[...]}'              # 更新 .env 配置
```

### 其他

```bash
curl http://localhost:3300/health                       # 健康检查
curl http://localhost:3300/api/config                   # 服务配置
curl http://localhost:3300/api/memory                   # 记忆文件列表
curl http://localhost:3300/api/mcp-servers              # MCP 服务器列表
curl -X POST http://localhost:3300/api/cleanup          # 手动清理 (含 Teams)
```

## 文件资源管理器

VS Code 风格的侧边栏文件树，基于会话工作目录 (CWD) 展示文件结构。

### 特性

- **SVG Seti 图标**: JS/TS/HTML/CSS/JSON/Python/Markdown/PDF/Word/PPT 等 30+ 文件类型专属图标
- **目录着色**: src(蓝)/node_modules(灰)/.git(红)/dist(绿)/test(黄)/docs(蓝) 等特殊目录
- **原生文件夹浏览**: 点击"📁 浏览"按钮调用 macOS 原生文件夹选择对话框
- **文件预览**: 点击文件直接在主区域预览，支持多种格式:

| 格式 | 预览方式 |
|------|---------|
| **HTML/HTM** | iframe 渲染模式 + 源码模式 (一键切换) |
| **Markdown** | 渲染模式 (排版/标题/代码块/表格) + 源码模式 |
| **PDF** | iframe 内嵌预览 |
| **图片** (PNG/JPG/GIF/SVG/WebP) | 图片预览 + 点击灯箱放大 |
| **代码** (JS/TS/CSS/Python/JSON/YAML 等) | 语法高亮 (highlight.js) |
| **PPT/Word/Excel** | 文件类型图标 + 下载按钮 |

- **文件删除**: hover 显示删除按钮，确认后删除文件并自动通知 AI (避免 AI 继续操作已删除的文件)
- **可调宽度**: 拖拽边缘调整侧边栏宽度
- **返回对话**: 一键返回聊天界面，或将文件引用插入对话

## 博弈引擎 v2.0 (Phase Toolkit)

规则定义能力边界，AI 自主决定执行路径。Phase Toolkit 提供 8 个阶段工具 + 10 种预设协议。

| 协议 | 触发关键词 | 阶段组合 |
|------|-----------|---------|
| **auto** | 默认 | AI 自主组合 |
| **formal** | 商业化博弈 | OPENING → CROSS-EXAM → REBUTTAL → CONSENSUS → META → AWAKENING |
| **quick** | 快速对比 | OPENING → META |
| **deep** | 深度研究 | OPENING → CROSS-EXAM(3-5) → REBUTTAL → CONSENSUS → META → AWAKENING |
| **red-blue** | 红蓝对抗 | OPENING → CROSS-EXAM → REBUTTAL → META |
| **investment** | 投资评审 | OPENING → CROSS-EXAM → RISK → META |
| **brainstorm** | 头脑风暴 | BRAINSTORM → CROSS-EXAM → META |

## Agent Teams 与委派模式

| 模式 | 工具限制 | 适用场景 |
|------|----------|---------|
| **off** | 无限制 | 默认 |
| **soft** | 无限制，提示注入 | 一般协作 |
| **strict** | 禁用 Edit/Write/Bash | 博弈、审查 |

## 端口分配

| 服务 | 端口 |
|------|------|
| **SwarmPath Agent Bridge** | **3300** |
