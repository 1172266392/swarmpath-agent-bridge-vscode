# 开发知识库

<!--
  参考 ZeroClaw 记忆系统设计：精华提炼，不是原始日志。
  每个条目都消耗 token，保持简洁。
  AI 自主维护：成功时添加，失败时标记，过时时删除。
-->

## 架构速查
- 入口: `dist/index.js` | 端口: 3300 | 前端: `web/index.html` (单文件 ~7800行)
- 启动: `node dist/index.js` | 关闭: `lsof -ti :3300 | xargs kill`
- 编译: `npm run build` (tsc)

### 三区架构 [2026-03-04] ✅
| Zone | 目录 | Git | 说明 |
|------|------|-----|------|
| 1 源码 | `src/` | tracked | TypeScript 源文件 |
| 2 知识 | `knowledge/` | tracked | skills, commands, agents, rules, memory, contexts |
| 3 数据 | `data/` | ignored | config, sessions, evolution, teams, tasks, uploads, sdk-cache |

### 数据生命周期 — 固定资产 vs 临时数据 [2026-03-04] ✅常用
| 数据 | 类型 | 会话关闭 | 启动清理 | 手动清理 |
|------|------|---------|---------|---------|
| Teams | **固定资产** | **保留** | **保留** | 按需删除 |
| Knowledge/Memory | **固定资产** | **保留** | **保留** | 不删 |
| Evolution data | **固定资产** | **保留** | **保留** | 不删 |
| Tasks | 临时 | 删除 | 清孤儿 | 删除 |
| Uploads | 临时 | 删除 | 清孤儿 | — |
| Session files | 临时 | 删除 | — | — |
→ Teams 是迭代自进化的积累，属于固定资产，只有显式 `POST /api/cleanup` 才清理

## 行为规则

### 用户交互工具空返回处理 [2026-03-03] ✅常用
`AskUserQuestion` 和 `ExitPlanMode` 在用户未实际交互时会立即返回空结果。
**必须停下来用文字重新提示**，绝不能假设用户已同意并继续执行。
→ AskUserQuestion：answers 为空或所有值为空字符串 → 用文字重新提问
→ ExitPlanMode：工具自动返回不代表用户已批准 → 等待用户明确回复后再实施

### Bridge MCP 安装正确路径 [2026-03-03] ✅常用
MCP 必须通过 Bridge API 安装，写入 `data/config/mcp-servers.json`。
**禁止**操作 `~/.claude/` 或 `~/.claude.json`（Bridge 安全边界外）。
→ 正确做法：`curl -X POST http://localhost:3300/api/mcp-servers -H 'Content-Type: application/json' -d '{...}'`
→ 字段：`name`(必须) `transport`(stdio/sse/http) `command` `args` `enabled` `description`
→ `claude mcp add` 会写入 `~/.claude.json`（错误位置），禁止使用
→ 验证：`curl http://localhost:3300/api/mcp-servers`

## 已验证模式

### CSS display 切换 [2026-03-03] ✅常用
CSS 默认 `display:none` 时，JS `el.style.display=''` 回退到 CSS 默认值（仍然 none）。
→ 必须 `display='block'` 或 `'flex'` 显式设置。

### 代码块语言标记 [2026-03-03] ✅
正则 `[\w-]*` 不匹配 `.`，`\`\`\`file.js` 无法解析。
→ 用 `[\w./-]*`。文件名需 `resolveHljsLang()` 映射扩展名为 hljs 别名。

### PreToolUse allowedDirs [2026-03-03] ✅常用
`allowedDirs` 必须包含所有需写入的目录。BRIDGE_ROOT 缺失会导致 npm install 被拒。
→ 确保 `normalize(resolve(BRIDGE_ROOT))` 在 allowedDirs 数组中。

### 文件卡片中文匹配 [2026-03-03] ✅
"文件名 已保存到 /路径/" 时文件名和路径分开，单一路径正则无法匹配。
→ 额外模式: `/([\w.-]+\.\w{2,5})\s*(?:已保存到|saved to)[\s\S]{0,60}?(\/[\w./-]+\/)/gi`

### 依赖管理边界 [2026-03-03] ✅常用
npm 包只装 BRIDGE_ROOT/node_modules。严禁 session cwd 安装，失败也不回退。
→ 系统提示 + PreToolUse 双重保障。

### 记忆编辑器双模式 [2026-03-03] ✅
只读渲染 (md→HTML) ↔ 编辑 (textarea)。`_memEditorRawContent` 缓存原始内容。
→ 切编辑: `display='block'`; 切渲染: `display='none'` + innerHTML 重新渲染。

### 网页文档批量抓取 — smart-web-fetch 实战 [2026-03-05] ✅常用

**场景**: 将 docs.anthropic.com 75页文档抓取为本地结构化 Markdown

**降级策略优先级（关键结论）**:
- ❌ Jina Reader 不适合 SPA/CSR 站点 — 不执行 JS，拿到 "Loading..." 空壳 + 侧边栏噪音
- ✅ **markdown.new 优先** — 会渲染 JS，返回干净 Markdown，无导航/页脚噪音
- 降级顺序: `markdown.new → Jina → defuddle.md → raw`（与原 skill 相反）

**URL 格式踩坑**:
- Anthropic 文档真实路径: `https://docs.anthropic.com/en/docs/...`（`/en/docs/`）
- 侧边栏链接显示: `/docs/en/...`（会 307 重定向循环）
- Jina URL 必须用 `https://r.jina.ai/https://...`（原 skill 用 `http://` 导致失败）
- 根路径 `/en/docs` 在 markdown.new 返回 404，需用 `/en/docs/intro`

**内容质量验证**:
```python
def is_valid_content(content):
    if len(content) < 200: return False       # 太短
    if content.count("Loading...") > 3: return False  # JS 未渲染
    if "# " not in content: return False       # 无 markdown 标题
    return True
```

**批量抓取最佳实践**:
- 先测 3 个页面验证质量，再批量（用户反馈：别鲁莽）
- 并发 4 线程 + 45s 超时
- 每页添加 frontmatter 元信息（title/source/fetched_via/date）
- 自动生成 INDEX.md 索引

**最终结果**: 75/75 成功，2.6 MB 干净 Markdown，全部走 markdown.new

## 待优化 (性能)

### 后端高优先级
- 同步 I/O (readFileSync) → fs/promises [未修]
- killChildClaude execSync in finally → async [未修]
- loadMemoryLayers 每查询读6文件 → mtime TTL 缓存 [未修]
- skill 目录每次 readdirSync → 缓存+install失效 [未修]

### 前端高优先级
- innerHTML 全量重建 → 虚拟化/增量更新 [未修]
- 事件监听器重复绑定 → 事件委派 [未修]
- applyHighlight 全文档扫描 → scope 到容器 [未修]
- md() 无缓存 → memoize [未修]
- saveMessages 全量序列化 → debounce [未修]
