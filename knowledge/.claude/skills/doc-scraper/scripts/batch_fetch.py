#!/usr/bin/env python3
"""
Doc Scraper — 批量抓取脚本
读取 pages.json 配置，批量抓取文档页面并保存为结构化 Markdown。

用法:
  python3 batch_fetch.py pages.json
  python3 batch_fetch.py pages.json --workers 8
  python3 batch_fetch.py pages.json --dry-run

pages.json 格式:
{
  "base_url": "https://docs.example.com",
  "output_dir": "./example-docs",
  "max_workers": 4,
  "categories": {
    "01-getting-started": {
      "intro": "/en/docs/intro",
      "quickstart": "/en/docs/quickstart"
    }
  }
}
"""

import os
import sys
import json
import time
import re
import urllib.request
import ssl
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# === 配置 ===
TIMEOUT = 45
RETRY = 2

ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,text/plain,text/markdown,*/*',
}


# === 内容验证 ===
def is_valid_content(content: str) -> bool:
    """验证内容是否有效（非 Loading... 空壳）"""
    if len(content) < 200:
        return False
    if content.count("Loading...") > 3:
        return False
    if "# " not in content:
        return False
    return True


# === 四级降级策略 ===
def fetch_with_markdown_new(url: str) -> tuple:
    """首选: markdown.new（JS 渲染后的干净 Markdown）"""
    md_url = f"https://markdown.new/{url}"
    req = urllib.request.Request(md_url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl_context) as resp:
        content = resp.read().decode("utf-8", errors="replace")
    if is_valid_content(content):
        return content, "markdown.new"
    raise ValueError("markdown.new returned invalid content")


def fetch_with_jina(url: str) -> tuple:
    """降级 1: Jina Reader"""
    jina_url = f"https://r.jina.ai/{url}"
    req = urllib.request.Request(jina_url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl_context) as resp:
        content = resp.read().decode("utf-8", errors="replace")
    if is_valid_content(content):
        return content, "jina"
    raise ValueError("Jina returned invalid content")


def fetch_with_defuddle(url: str) -> tuple:
    """降级 2: defuddle.md"""
    df_url = f"https://defuddle.md/{url}"
    req = urllib.request.Request(df_url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl_context) as resp:
        content = resp.read().decode("utf-8", errors="replace")
    if is_valid_content(content):
        return content, "defuddle"
    raise ValueError("defuddle returned invalid content")


def fetch_raw(url: str) -> tuple:
    """最终兜底: 原始内容"""
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl_context) as resp:
        content = resp.read().decode("utf-8", errors="replace")
    return content, "raw"


def fetch_page(url: str, retries: int = RETRY) -> tuple:
    """降级策略: markdown.new → Jina → defuddle → raw"""
    strategies = [fetch_with_markdown_new, fetch_with_jina, fetch_with_defuddle, fetch_raw]
    last_error = None

    for strategy in strategies:
        for attempt in range(retries):
            try:
                content, source = strategy(url)
                return content, source
            except Exception as e:
                last_error = e
                if attempt < retries - 1:
                    time.sleep(1)
                continue

    return f"# Fetch Failed\n\nURL: {url}\nError: {last_error}", "error"


# === 页面处理 ===
def process_page(base_url: str, output_dir: Path, category: str, name: str, path: str) -> dict:
    """处理单个页面"""
    url = f"{base_url}{path}"
    print(f"  📥 [{category}] {name} ...", flush=True)

    content, source = fetch_page(url)

    # 添加 frontmatter 元信息
    header = (
        f"---\ntitle: {name}\n"
        f"source: {url}\n"
        f"fetched_via: {source}\n"
        f"date: {time.strftime('%Y-%m-%d')}\n---\n\n"
    )
    final_content = header + content

    # 保存文件
    cat_dir = output_dir / category
    cat_dir.mkdir(parents=True, exist_ok=True)
    file_path = cat_dir / f"{name}.md"
    file_path.write_text(final_content, encoding="utf-8")

    size_kb = len(final_content.encode("utf-8")) / 1024
    status = "✅" if source != "error" else "❌"
    print(f"  {status} [{category}] {name} — {source} ({size_kb:.1f} KB)", flush=True)

    return {
        "category": category,
        "name": name,
        "path": path,
        "source": source,
        "size_kb": round(size_kb, 1),
        "file": str((cat_dir / f"{name}.md").relative_to(output_dir)),
    }


# === 索引生成 ===
def generate_index(output_dir: Path, base_url: str, results: list):
    """生成 INDEX.md 索引文件"""
    lines = [
        f"# 文档镜像",
        "",
        f"> 抓取日期: {time.strftime('%Y-%m-%d %H:%M')}",
        f"> 总页数: {len(results)}",
        f"> 来源: {base_url}",
        "",
    ]

    source_badges = {
        "markdown.new": "🟢 md.new",
        "jina": "🟡 Jina",
        "defuddle": "🟠 defuddle",
        "raw": "🔴 Raw",
        "error": "❌ Failed",
    }

    current_cat = ""
    for r in sorted(results, key=lambda x: (x["category"], x["name"])):
        if r["category"] != current_cat:
            current_cat = r["category"]
            display_cat = re.sub(r"^\d+-", "", current_cat).replace("-", " ").title()
            lines.append(f"\n## {display_cat}\n")
            lines.append("| 文档 | 来源 | 大小 |")
            lines.append("|------|------|------|")

        badge = source_badges.get(r["source"], r["source"])
        lines.append(f"| [{r['name']}]({r['file']}) | {badge} | {r['size_kb']} KB |")

    index_path = output_dir / "INDEX.md"
    index_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n📋 索引文件: {index_path}")


# === 主函数 ===
def main():
    if len(sys.argv) < 2:
        print("Usage: batch_fetch.py <pages.json> [--workers N] [--dry-run]", file=sys.stderr)
        sys.exit(1)

    config_path = Path(sys.argv[1])
    if not config_path.exists():
        print(f"Error: {config_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    base_url = config["base_url"].rstrip("/")
    output_dir = Path(config.get("output_dir", "./docs-output")).resolve()
    max_workers = config.get("max_workers", 4)
    categories = config["categories"]

    # CLI 参数覆盖
    for i, arg in enumerate(sys.argv):
        if arg == "--workers" and i + 1 < len(sys.argv):
            max_workers = int(sys.argv[i + 1])

    dry_run = "--dry-run" in sys.argv

    # 统计
    total = sum(len(pages) for pages in categories.values())
    print(f"🚀 开始抓取文档 — 共 {total} 页")
    print(f"📂 输出目录: {output_dir}")
    print(f"🌐 来源: {base_url}")
    print(f"⚙️  并发数: {max_workers}")
    print(f"📋 降级策略: markdown.new → Jina → defuddle → raw\n")

    if dry_run:
        for cat, pages in categories.items():
            for name, path in pages.items():
                print(f"  [DRY] [{cat}] {name} → {base_url}{path}")
        print(f"\n📊 共 {total} 页 (dry run, 未实际抓取)")
        return

    output_dir.mkdir(parents=True, exist_ok=True)

    # 构建任务
    tasks = []
    for cat, pages in categories.items():
        for name, path in pages.items():
            tasks.append((cat, name, path))

    results = []

    # 并发执行
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(process_page, base_url, output_dir, cat, name, path): (cat, name)
            for cat, name, path in tasks
        }
        for future in as_completed(futures):
            cat, name = futures[future]
            try:
                result = future.result()
                results.append(result)
            except Exception as e:
                print(f"  ❌ [{cat}] {name} — Error: {e}")
                results.append({
                    "category": cat, "name": name, "path": "",
                    "source": "error", "size_kb": 0, "file": "",
                })

    # 生成索引
    generate_index(output_dir, base_url, results)

    # 统计报告
    success = sum(1 for r in results if r["source"] != "error")
    total_size = sum(r["size_kb"] for r in results)
    print(f"\n{'='*50}")
    print(f"📊 抓取完成: {success}/{total} 成功")
    print(f"📦 总大小: {total_size:.1f} KB")

    sources = {}
    for r in results:
        sources[r["source"]] = sources.get(r["source"], 0) + 1
    for src, count in sorted(sources.items()):
        print(f"   {src}: {count} 页")

    if success < total:
        failed = [r for r in results if r["source"] == "error"]
        print(f"\n⚠️  失败页面:")
        for r in failed:
            print(f"   - [{r['category']}] {r['name']}")


if __name__ == "__main__":
    main()
