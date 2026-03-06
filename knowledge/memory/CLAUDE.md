# Claude — Project Rules

<!-- 这些规则注入到所有会话的系统提示中，可在前端设置面板中编辑 -->

## 三区架构
- **Zone 1 (src/)**: 源码 — git tracked
- **Zone 2 (knowledge/)**: 知识内容 — git tracked, 含 skills/commands/agents/rules/memory/contexts
- **Zone 3 (data/)**: 运行时数据 — gitignored, 含 config/sessions/evolution/teams/tasks/uploads/sdk-cache

## 数据生命周期 — 固定资产保护
- **固定资产** (不随会话删除): Teams、Knowledge/Memory、Evolution data
- **临时数据** (随会话删除): Tasks、Uploads、Session files
- Teams 是迭代自进化的积累，**删除会话时只删 tasks 不删 teams**
- 只有用户显式请求 (POST /api/cleanup) 才清理 teams

## Bridge 安全边界
- 禁止访问用户 home 目录下的个人配置文件，它们与 Bridge 无关
- SDK 配置目录已重定向到 Bridge 内部 (CLAUDE_CONFIG_DIR)，teams/tasks 数据存储在 Bridge 的 data 目录下
- 只在会话授权目录范围内操作

## 依赖管理 (严格)
- **所有 npm 包必须安装到 Bridge 根目录** (路径见 [Bridge Environment] 段的 `Bridge root`)
  - 正确: `cd <bridge-root> && npm install <package>`
  - **严禁**: 在会话工作目录 (session cwd) 下执行 `npm install`、`npm add`、`pip install` 等任何包安装命令
  - **严禁**: 在会话工作目录下创建 node_modules、package.json 等依赖文件
- 即使 Bridge 根目录安装失败，也**绝不**回退到会话工作目录安装，而是报告错误让用户处理
- 安装后，用 `require('<bridge-root>/node_modules/<package>')` 或动态 `import()` 加载
- 禁止在 Bridge 根目录之外搜索或使用其他项目的 node_modules

## 输出文件规则
- 生成的文件 (docx, pptx, images 等) 保存到会话工作目录
- 不要保存到 skill 目录或 bridge 根目录

## Skill 使用规则
- 当 [Installed Skills] 段列出了可用 skill 时，读取对应的 SKILL.md 文件，然后按其说明执行
- Skill 是基于文件的 (SKILL.md)，**不是** slash command — 禁止调用 Skill() 工具
- 禁止用 Agent 工具创建子 agent 来执行 skill — 直接自己执行
- 禁止在会话项目中 npm install，skill 依赖已在 bridge 全局预装
- SKILL.md 中的脚本路径 (如 "scripts/xxx.py") 是**相对于 skill 目录**的
  - 必须加上 skill 绝对路径前缀 (路径见 [Installed Skills] 段)
  - 示例: "python scripts/office/validate.py" → "python <skills-path>/docx/scripts/office/validate.py"

### Skill 选择策略 (Best-Fit Selection)
当多个 skill 功能重叠时，必须选择**最匹配当前任务**的 skill，而非随意选一个:
1. **精确匹配优先**: 任务类型完全符合 skill 描述的 → 直接用
2. **专用 > 通用**: 专门针对特定格式/场景的 skill 优于通用 skill (如: 生成 PPTX → 用 pptx skill 而非通用 canvas-design)
3. **复合任务拆分**: 需要多个 skill 配合时，每步选最佳 skill，不要用一个 skill 硬做所有事
4. **禁止重复执行**: 不要对同一任务同时调用多个功能重叠的 skill
5. **如不确定**: 快速浏览候选 skill 的 SKILL.md 开头描述，选最合适的

## 工具使用偏好
- 优先使用专用工具 (Read, Edit, Grep) 而非 Bash 等效命令
- 写入文件前验证路径是否在授权目录内

## Agent Teams — 委派模式规则
当委派模式激活时: 你是 Team Lead（协调者）。
- 用 Agent 工具派生子 agent 执行工作，禁止模拟/伪造 Agent 回复
- 用 TaskCreate 分解任务 → SendMessage 发上下文 → 等待真实回复
- **strict 模式**: 禁止直接 Edit/Write/NotebookEdit/Bash，全部委派

## Agent Teams — 博弈模式
<!-- 详细规则按需加载自 DEBATE_RULES.md，此处仅保留摘要 -->
博弈模式核心: 多 Agent 真实辩论，禁止单 Agent 模拟。
详细协议路径和阶段工具箱见系统提示中的 [DEBATE_RULES] 段。

## 三层记忆系统 (自主管理，自主迭代)
详见系统提示 [Memory System] 段。核心规则:
- **第一层 (身份)**: USER.md/SOUL.md/IDENTITY.md/STYLE.md/CLAUDE.md → 用户身份、AI人格、项目规则
- **第二层 (知识)**: KNOWLEDGE.md → 成功模式、踩坑记录、解决方案 (AI 自主迭代维护)
- **第三层 (会话)**: `{sessionId}.memory.md` → 临时上下文，会话关闭时删除
- 先回答用户，再静默写入；写入前 Read 现有内容，用 Edit 追加
- KNOWLEDGE.md 条目标记: ✅验证 / ✅常用 / ⚠️待验证 / ❌废弃(应删除)

## Skill 安装搜索
当用户请求安装 skill 但没有提供 GitHub URL 时:
- 用 WebSearch 搜索对应的 GitHub 仓库
- 找到后**必须立即用 Bash 调用安装 API**，不要只返回 URL:
  ```bash
  curl -s -X POST http://localhost:3300/api/skills/install \
    -H 'Content-Type: application/json' \
    -d '{"repoUrl":"https://github.com/user/repo","scope":"global"}'
  ```
- 安装完成后告知用户结果

## 用户上传文件处理
- 当提示中包含 [Uploaded Images] 或 [Uploaded Files] 段时，先用 Read 工具读取列出的文件，然后再回答
- 图片文件用 Read 工具读取 (Read 支持图片)
- 其他文件同样用 Read 工具读取内容

## 开发经验知识库
- 项目开发的成功模式、踩坑记录、性能分析等详见 `memory/KNOWLEDGE.md`
- 当涉及 Bridge 项目开发时，先 Read 该文件获取历史经验
