#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音符弹跳 · 本地音乐服务
- 提供游戏页面
- 扫描本地音乐目录，提供歌单 API
- 支持 Range 流式播放（浏览器音频必需）
"""
import os
import re
import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)  # 内部存储 根目录

DEFAULT_DIRS = [
    os.path.join(ROOT, " 我的文件", "files (online-audio-converter.com)"),
    os.path.join(ROOT, " 我的文件"),
    os.path.join(ROOT, "Music"),
    os.path.join(ROOT, "Download"),
    os.path.join(ROOT, "Sounds"),
]

EXTS = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"}

MIME = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".opus": "audio/ogg",
}

SONGS = []          # [{'id':0,'path':...,'title':...,'artist':...,'size':...}]
SCANNED = False


def split_title(name):
    name = os.path.splitext(name)[0]
    # 常见形式：歌手 - 歌曲 / 歌手-歌曲
    for sep in (" - ", " – ", " — ", "-"):
        if sep in name:
            a, b = name.split(sep, 1)
            a, b = a.strip(), b.strip()
            if a and b:
                # 去掉 [mqms2] 之类尾巴
                b = re.sub(r"\s*[\[\(【].*?[\]\)】]\s*$", "", b).strip()
                return b or name, a
    return name, ""


def scan(force=False):
    global SONGS, SCANNED
    if SCANNED and not force:
        return SONGS
    seen = set()
    out = []
    dirs = list(DEFAULT_DIRS) + [os.path.abspath(p) for p in sys.argv[1:]]
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for root, subdirs, files in os.walk(d):
            subdirs[:] = [x for x in subdirs if not x.startswith(".")]
            for f in files:
                if os.path.splitext(f)[1].lower() not in EXTS:
                    continue
                p = os.path.join(root, f)
                rp = os.path.realpath(p)
                if rp in seen:
                    continue
                seen.add(rp)
                title, artist = split_title(f)
                try:
                    size = os.path.getsize(p)
                except OSError:
                    size = 0
                out.append({
                    "title": title,
                    "artist": artist,
                    "file": f,
                    "dir": os.path.basename(root),
                    "size": size,
                    "path": p,
                })
    out.sort(key=lambda x: x["title"])
    for i, s in enumerate(out):
        s["id"] = i
    SONGS = out
    SCANNED = True
    return SONGS


def human(n):
    if n > 1024 * 1024:
        return "%.1f MB" % (n / 1048576.0)
    return "%d KB" % (n / 1024)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path, ctype=None):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        if ctype is None:
            ctype = MIME.get(os.path.splitext(path)[1].lower(),
                             "application/octet-stream")
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = int(m.group(2))
                end = min(end, size - 1)
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range",
                             "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = urllib.parse.unquote(u.path)

        if p in ("/", "/index.html"):
            return self._file(os.path.join(BASE, "index.html"),
                              "text/html; charset=utf-8")
        if p == "/game.js":
            return self._file(os.path.join(BASE, "game.js"),
                              "application/javascript; charset=utf-8")
        if p == "/api/songs":
            songs = scan()
            items = []
            for s in songs:
                items.append({
                    "id": s["id"],
                    "title": s["title"],
                    "artist": s["artist"],
                    "file": s["file"],
                    "dir": s["dir"],
                    "size": s["size"],
                    "sizeText": human(s["size"]),
                })
            return self._json({"ok": True, "count": len(items), "songs": items})
        if p == "/api/rescan":
            songs = scan(force=True)
            return self._json({"ok": True, "count": len(songs)})

        m = re.match(r"^/music/(\d+)$", p)
        if m:
            idx = int(m.group(1))
            songs = scan()
            if 0 <= idx < len(songs):
                return self._file(songs[idx]["path"])
            self.send_error(404)
            return

        self.send_error(404)

    def do_HEAD(self):
        self.do_GET()


def main():
    port = 8000
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    songs = scan()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 46)
    print("  音符弹跳 · NEON BOUNCE")
    print("=" * 46)
    print("  本地音乐库扫描到 %d 首歌曲" % len(songs))
    print("  请在浏览器打开： http://localhost:%d" % port)
    print("  停止服务： Ctrl + C")
    print("=" * 46)
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
