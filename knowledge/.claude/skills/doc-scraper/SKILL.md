---
name: doc-scraper
description: 将任意文档网站批量抓取为本地结构化 Markdown 文件。当用户提到"爬取文档"、"抓取官网"、"下载文档到本地"、"文档离线化"、"把 XX 的 docs 保存下来"、"抓取 API 文档"时使用此 skill。也适用于需要将在线文档转为知识库、RAG 语料、或本地参考资料的场景。
---

# Doc Scraper

将在线文档网站批量抓取为结构化的本地 Markdown 文件集合。

## 核心能力

- **站点结构发现**: 自动抓取首页，解析导航/侧边栏，提取所有文档页面 URL
- **智能内容获取**: 四级降级策略（markdown.new → Jina → defuddle.md → raw）
- **内容质量验证**: 自动检测 "Loading..." 空壳、内容过短、缺少标题等问题
- **结构化输出**: 按分类目录组织，每个文件附带 frontmatter 元信息，自动生成 INDEX.md

## 工作流程

### Phase 1: 探索站点结构

1. 用 `scripts/fetch_page.py` 获取文档首页
2. 分析导航结构，提取所有文档页面 URL
3. 按逻辑分类组织 URL（如 "getting-started", "api-reference", "guides" 等）
4. **关键**: 先测试 2-3 个页面验证内容质量，确认无 "Loading..." 等问题后再批量

```bash
# 获取单个页面（纯文本输出）
python3 {baseDir}/scripts/fetch_page.py "https://docs.example.com/getting-started"

# 获取单个页面（JSON 输出，含元信息）
python3 {baseDir}/scripts/fetch_page.py "https://docs.example.com/getting-started" --json
```

### Phase 2: 生成页面清单

基于 Phase 1 的分析，创建 `pages.json` 配置文件：

```json
{
  "base_url": "https://docs.example.com",
  "output_dir": "./example-docs",
  "max_workers": 4,
  "categories": {
    "01-getting-started": {
      "intro": "/en/docs/intro",
      "quickstart": "/en/docs/quickstart"
    },
    "02-api-reference": {
      "authentication": "/en/docs/api/auth",
      "endpoints": "/en/docs/api/endpoints"
    }
  }
}
```

### Phase 3: 批量抓取

```bash
python3 {baseDir}/scripts/batch_fetch.py pages.json
```

脚本会：
- 并发抓取所有页面（默认 4 线程）
- 每个页面走四级降级策略
- 验证内容质量（拒绝 "Loading..." 空壳）
- 保存为 `{category}/{name}.md`，附带 frontmatter
- 生成 `INDEX.md` 索引文件
- 输出统计报告

### Phase 4: 质量检查

抓取完成后检查：
```bash
# 检查是否有 Loading... 残留
grep -rl "Loading\.\.\." --include="*.md" <output_dir>/

# 检查是否有 Not Found
grep -rl "Not Found" --include="*.md" <output_dir>/

# 查看统计
cat <output_dir>/INDEX.md
```

## 降级策略详解

| 优先级 | 服务 | URL 格式 | 特点 |
|--------|------|----------|------|
| 1 (首选) | markdown.new | `https://markdown.new/{url}` | 渲染 JS，输出最干净 |
| 2 | Jina Reader | `https://r.jina.ai/{url}` | 免费快速，但不执行 JS |
| 3 | defuddle.md | `https://defuddle.md/{url}` | 备用清洗服务 |
| 4 (兜底) | Raw | 直接请求 | 原始 HTML，最后手段 |

**重要**: 对于 SPA/CSR 站点（如 React/Next.js 构建的文档站），必须优先 markdown.new。
Jina Reader 不执行 JavaScript，会拿到 "Loading..." 空壳。

## 常见陷阱

### URL 路径格式
很多文档站的侧边栏链接和实际 URL 格式不同：
- 侧边栏显示: `/docs/en/intro` → 实际: `/en/docs/intro`
- 需要在 Phase 1 验证真实可访问的 URL 格式

### Jina Reader URL
- 正确: `https://r.jina.ai/https://docs.example.com/page`
- 错误: `https://r.jina.ai/http://docs.example.com/page`（http vs https 会影响结果）

### 根路径问题
文档站首页（如 `/en/docs`）在部分清洗服务可能返回 404。
需要用完整路径（如 `/en/docs/intro`）。

## 输出格式

每个 Markdown 文件包含 frontmatter：
```yaml
---
title: page-name
source: https://docs.example.com/en/docs/page
fetched_via: markdown.new
date: 2026-03-05
---
```

INDEX.md 包含：
- 抓取日期、总页数、来源 URL
- 按分类组织的文件列表，标注数据来源和文件大小

## 零依赖

所有脚本使用 Python 标准库（urllib, ssl, json, concurrent.futures），无需安装额外包。
