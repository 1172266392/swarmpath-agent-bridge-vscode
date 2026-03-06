#!/usr/bin/env python3
"""
Doc Scraper — 单页抓取脚本
四级降级策略: markdown.new → Jina → defuddle.md → raw
"""

import sys
import json
import time
import urllib.request
import ssl

TIMEOUT = 45
RETRY = 2

ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,text/plain,text/markdown,*/*',
}


def is_valid_content(content: str) -> bool:
    """验证内容是否有效"""
    if len(content) < 200:
        return False
    if content.count("Loading...") > 3:
        return False
    if "# " not in content:
        return False
    return True


def fetch_with_markdown_new(url: str) -> tuple:
    """首选: markdown.new"""
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
    """四级降级策略获取页面"""
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


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch_page.py <url> [--json]", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    as_json = "--json" in sys.argv

    content, source = fetch_page(url)

    if as_json:
        result = {
            "success": source != "error",
            "url": url,
            "content": content,
            "source": source,
            "error": None if source != "error" else str(content),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"# Source: {source}")
        print(f"# URL: {url}")
        print()
        print(content)


if __name__ == "__main__":
    main()
