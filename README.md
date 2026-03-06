# SwarmPath Agent Bridge

将 Claude Agent SDK 的完整终端能力通过 HTTP/SSE 暴露给 Web 前端，内置 Evolution Engine 自进化系统。

## 架构

```
┌──────────────────┐     SSE      ┌────────────────────┐     SDK      ┌────────────────┐
│   Web Frontend   │ ◄──────────► │  Agent Bridge API  │ ◄──────────► │  Claude Agent   │
│  (单文件 HTML)    │  /api/stream │  (Fastify :3300)   │   query()   │  SDK Process    │
└──────────────────┘              └────────────────────┘              └────────────────┘
                                         │
                                  Session Manager + Evolution Engine
                                  (文件持久化 + 自进化 + Instinct 学习)
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
│   │   ├── session.routes.ts     # 会话 CRUD + Skill 管理
│   │   ├── evolution.routes.ts   # Evolution Engine + Cron + Heartbeat + Webhook + Exec
│   │   └── knowledge.routes.ts   # 知识内容 CRUD API
│   ├── services/
│   │   ├── sdk-bridge.ts         # SDK 封装
│   │   ├── session-manager.ts    # 路径常量 + 会话持久化 + 数据生命周期
│   │   ├── evolution-engine.ts   # 自进化引擎 + Instinct 提取
│   │   ├── background-exec.ts    # 后台命令执行
│   │   └── lane-queue.ts         # 并发队列
│   └── utils/
│       └── message-transform.ts  # Raw SDK → SSE Event 转换
├── web/
│   └── index.html                # 全功能 Web 终端 UI (单文件)
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
│   ├── config/                   # server-config.json, mcp-servers.json
│   ├── sessions/                 # 会话 JSON 持久化
│   ├── evolution/                # findings, metrics, proposals, instincts, observations
│   ├── teams/                    # Agent 团队 (固定资产, 不随会话删除)
│   ├── tasks/                    # 任务追踪 (临时, 随会话删除)
│   ├── uploads/                  # 附件存储
│   └── sdk-cache/                # SDK 自动生成
├── dist/                         # tsc 编译输出
├── package.json
├── tsconfig.json
└── .env
```

## 版本历史

| 版本 | 核心改动 |
|------|---------|
| **v2.2** (当前) | VS Code 风格文件资源管理器 + 统一模型渠道管理 + 文件预览系统 + .env 配置 UI |
| **v2.1** | 三区架构 + ECC 知识集成 + Evolution Engine v2 (Instinct 学习) + 数据生命周期管理 |
| **v2.0** | 会话导出 (PNG/MD) + 主题切换 + 博弈引擎增强 (Iron Rules) + 报告卡片渲染 |
| **v1.2** | MCP 服务器管理 + Skill 系统 + Plan-First 审批 |
| **v1.1** | Agent Teams + P2P 可视化 + 博弈引擎 v2.0 Phase Toolkit + 三层记忆 |
| **v1.0** | 基础架构: 多会话 + SSE 流式 + 授权目录 + 附件上传 + 主题系统 |

## 核心能力

| 能力 | 说明 |
|------|------|
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
| **文件资源管理器** | VS Code 风格侧边栏文件树，SVG Seti 图标，目录展开/折叠，点击预览 |
| **文件预览系统** | HTML 渲染/源码双模式，Markdown 渲染，PDF iframe，图片预览+灯箱，代码语法高亮 |
| **模型渠道管理** | 统一 UI 管理多 AI 供应商 (Anthropic/DeepSeek/Qwen/MiniMax)，卡片式渠道列表+编辑弹窗 |
| **.env 配置 UI** | 前端可视化编辑运行时环境变量 (端口/模型/权限/超时等) |
| **MCP 服务器** | 设置面板管理 MCP 扩展工具，自然语言安装 |
| **Skill 系统** | 全局/项目级 Skill 安装，基于 SKILL.md 文件协议 |
| **会话导出** | PNG 截图 (html2canvas+样式烘焙) + Markdown 导出 |
| **Live Reload** | WebSocket + fs.watch, 编辑 web/ 自动刷新浏览器 |

## 快速开始

```bash
cd swarmpath-agent-bridge
cp .env.example .env
# 编辑 .env 填入 ANTHROPIC_API_KEY

npm install
npm run build
node dist/index.js
```

服务启动在 `http://localhost:3300`。

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
```

### 流式查询 (SSE)

```bash
curl -N -X POST http://localhost:3300/api/stream \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "xxx", "prompt": "Read package.json and summarize"}'
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

### 模型渠道

```bash
curl http://localhost:3300/api/model-channels                              # 渠道列表 (API Key 脱敏)
curl -X POST http://localhost:3300/api/model-channels \
  -H 'Content-Type: application/json' \
  -d '{"id":"deepseek","name":"DeepSeek","apiKey":"sk-...","baseUrl":"https://api.deepseek.com","models":["deepseek-chat","deepseek-reasoner"],"enabled":true}'
curl -X PATCH http://localhost:3300/api/model-channels/deepseek \
  -H 'Content-Type: application/json' -d '{"enabled":false}'              # 更新渠道
curl -X DELETE http://localhost:3300/api/model-channels/deepseek           # 删除渠道
```

### 文件浏览

```bash
curl http://localhost:3300/api/tree/{sessionId}?depth=4                    # 获取文件树
curl http://localhost:3300/api/file-content/{sessionId}?path=src/index.ts  # 获取文件内容 (文本)
curl http://localhost:3300/api/files/{sessionId}?path=logo.png             # 获取原始文件 (二进制)
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
- **文件预览**: 点击文件直接在主区域预览，支持多种格式:

| 格式 | 预览方式 |
|------|---------|
| **HTML/HTM** | iframe 渲染模式 + 源码模式 (一键切换) |
| **Markdown** | 渲染模式 (排版/标题/代码块/表格) + 源码模式 |
| **PDF** | iframe 内嵌预览 |
| **图片** (PNG/JPG/GIF/SVG/WebP) | 图片预览 + 点击灯箱放大 |
| **代码** (JS/TS/CSS/Python/JSON/YAML 等) | 语法高亮 (highlight.js) |
| **PPT/Word/Excel** | 文件类型图标 + 下载按钮 |

- **可调宽度**: 拖拽边缘调整侧边栏宽度
- **返回对话**: 一键返回聊天界面，或将文件引用插入对话

## 模型渠道管理

统一管理所有 AI 模型供应商的 API 凭证，无需手动编辑配置文件。

### 渠道类型

| 渠道 | 存储位置 | 说明 |
|------|---------|------|
| **默认 (Anthropic)** | `.env` | ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL |
| **自定义渠道** | `data/config/model-channels.json` | DeepSeek/Qwen/MiniMax 等 |

### 运行机制

```
用户选择模型 → resolveModelChannel(model) → 查找匹配的 enabled 渠道
  ├─ 找到 → 注入 apiKey + baseUrl 到 SDK 环境变量
  └─ 未找到 → 回退到 .env 默认 Anthropic 凭证
```

前端设置面板中"模型渠道"区域提供卡片式管理: 启用/禁用 toggle、编辑弹窗、模型标签、API Key 脱敏显示。

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
