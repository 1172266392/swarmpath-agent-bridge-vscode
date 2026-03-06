# Doc Scraper Skill

将任意在线文档网站批量抓取为本地结构化 Markdown 文件集合。

## 快速开始

### 1. 单页测试

```bash
# 获取单个页面
python3 scripts/fetch_page.py "https://docs.anthropic.com/en/docs/intro"

# JSON 格式输出
python3 scripts/fetch_page.py "https://docs.anthropic.com/en/docs/intro" --json
```

### 2. 批量抓取

创建 `pages.json` 配置文件（参考 `pages.example.json`）：

```json
{
  "base_url": "https://docs.anthropic.com",
  "output_dir": "./anthropic-docs",
  "max_workers": 4,
  "categories": {
    "01-getting-started": {
      "intro": "/en/docs/intro",
      "quickstart": "/en/docs/get-started"
    }
  }
}
```

执行批量抓取：

```bash
python3 scripts/batch_fetch.py pages.json
```

## 核心特性

- **四级降级策略**: markdown.new → Jina Reader → defuddle.md → raw
- **内容质量验证**: 自动拒绝 "Loading..." 空壳、过短内容、缺少标题的页面
- **并发抓取**: 默认 4 线程，可通过 `--workers N` 调整
- **结构化输出**: 按分类目录组织，每个文件附带 frontmatter 元信息
- **自动索引**: 生成 INDEX.md 总览文件
- **零依赖**: 仅使用 Python 标准库

## 降级策略说明

| 优先级 | 服务 | 适用场景 |
|--------|------|----------|
| 1 | markdown.new | SPA/CSR 站点（React/Next.js 等），会渲染 JS |
| 2 | Jina Reader | 静态站点，速度快但不执行 JS |
| 3 | defuddle.md | 备用清洗服务 |
| 4 | Raw | 最终兜底，返回原始 HTML |

**重要**: 对于现代文档站（如 Anthropic Docs），必须优先 markdown.new，否则会拿到 "Loading..." 空壳。

## 输出格式

每个 Markdown 文件包含 frontmatter：

```yaml
---
title: intro
source: https://docs.anthropic.com/en/docs/intro
fetched_via: markdown.new
date: 2026-03-05
---
```

INDEX.md 包含：
- 抓取日期、总页数、来源 URL
- 按分类组织的文件列表
- 每个文件的数据来源和大小

## 常见问题

### Q: 为什么有些页面返回 "Loading..."？

A: 该站点使用客户端渲染（CSR），Jina Reader 不执行 JavaScript。确保 markdown.new 在降级策略的首位。

### Q: 如何处理 URL 路径格式问题？

A: 很多文档站的侧边栏链接和实际 URL 不同。先用 `fetch_page.py` 测试单个页面，确认真实可访问的路径格式。

### Q: 批量抓取失败率高怎么办？

A:
1. 降低并发数：`--workers 2`
2. 检查 URL 格式是否正确
3. 查看失败页面的错误信息

## 实战案例

成功抓取 Anthropic 官方文档 75 页（2.6 MB）：
- 全部通过 markdown.new 获取
- 0 个 "Loading..." 问题
- 0 个 "Not Found" 错误
- 按 16 个分类目录组织

配置文件见 Anthropic 文档抓取实例。

## 技术细节

- 超时: 45 秒
- 重试: 每个策略重试 2 次
- SSL: 禁用证书验证（部分清洗服务需要）
- User-Agent: 模拟 macOS Chrome 浏览器
