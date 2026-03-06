# Knowledge Base

SwarmPath Agent Bridge 知识库 — SDK 可发现内容、规则、代理定义和记忆。

## 目录结构

```
knowledge/
├── .claude/                  # SDK 兼容路径 (SDK 自动发现此结构)
│   ├── commands/ (34+)       # 聊天命令 (/plan, /code-review, /tdd, /evolve, ...)
│   └── skills/ (70+)         # 技能库 (api-design, mcp-builder, continuous-learning, ...)
├── agents/ (10)              # 子代理定义 (planner, architect, code-reviewer, ...)
├── rules/                    # 多层编码规则 (common + 语言专项)
│   ├── common/ (9)           # 通用规则 (coding-style, security, testing, ...)
│   ├── typescript/ (5)       # TypeScript 专项
│   ├── python/ (5)           # Python 专项
│   ├── golang/ (5)           # Go 专项
│   └── swift/ (5)            # Swift 专项
├── memory/                   # 项目记忆 (AI 可读写)
│   ├── CLAUDE.md             # 项目规则 (最重要)
│   ├── KNOWLEDGE.md          # 经验知识库 (自动迭代)
│   ├── SOUL.md               # AI 人格
│   ├── IDENTITY.md           # AI 身份
│   ├── STYLE.md              # 输出风格
│   └── USER.md               # 用户信息
├── contexts/                 # 上下文预设
│   ├── dev.md                # 开发模式 (实现优先)
│   ├── research.md           # 研究模式 (理解优先)
│   └── review.md             # 审查模式 (质量优先)
├── hooks/                    # 工具钩子定义
│   └── hooks.json            # Pre/PostToolUse 自动化
└── mcp-configs/              # MCP 服务器配置模板
    └── mcp-servers-template.json
```

## Agents

| Agent | 职责 |
|-------|------|
| `planner` | 任务分解、实施规划 |
| `architect` | 系统设计、架构决策 |
| `code-reviewer` | 代码审查、质量把关 |
| `security-reviewer` | 安全审计、漏洞检测 |
| `tdd-guide` | 测试驱动开发指导 |
| `e2e-runner` | 端到端测试执行 |
| `build-error-resolver` | 构建错误诊断修复 |
| `refactor-cleaner` | 重构清理 |
| `doc-updater` | 文档同步更新 |
| `chief-of-staff` | 多代理协调编排 |

## 核心 Skills (按用途分类)

### 开发流程
`tdd-workflow` `verification-loop` `verification-before-completion` `executing-plans` `writing-plans` `finishing-a-development-branch`

### 架构设计
`api-design` `backend-patterns` `frontend-patterns` `frontend-design` `postgres-patterns` `database-migrations` `deployment-patterns` `docker-patterns`

### AI / Agent
`autonomous-loops` `dispatching-parallel-agents` `subagent-driven-development` `mcp-builder` `cost-aware-llm-pipeline` `eval-harness` `continuous-learning` `continuous-learning-v2`

### 代码质量
`coding-standards` `security-review` `security-scan` `requesting-code-review` `receiving-code-review` `systematic-debugging` `e2e-testing` `test-driven-development` `webapp-testing`

### 内容生成
`article-writing` `writing-skills` `docx` `pdf` `pptx` `xlsx` `frontend-slides` `canvas-design`

### 工具
`configure-ecc` `skill-creator` `skill-stocktake` `using-git-worktrees` `using-superpowers` `search-first` `iterative-retrieval`

## 如何使用

- **SDK 自动加载**: `knowledge/.claude/` 下的 skills 和 commands 会被 Claude Agent SDK 自动发现
- **API 访问**: `GET /api/knowledge/stats` 查看总览, `/api/knowledge/agents` 列出代理
- **前端浏览**: 打开 Evo 面板 → 知识库区域
- **聊天命令**: `/knowledge list` 总览, `/knowledge agents` 列出代理
