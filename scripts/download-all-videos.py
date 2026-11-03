#!/usr/bin/env python3
"""Download every video on a multicam-server to a local folder.

Usage:
  python3 scripts/download-all-videos.py --server https://cam.whiteou7.id.vn \
      --phone 0900000001 [--out videos] [--session SESSION_ID]

Logs in with a Controller account (the password is asked for interactively),
pages through GET /videos, and saves each clip as
<out>/<created_at>_<camera>_<id8>.mp4. Files already present with the right
size are skipped, so re-running only fetches new clips.
"""

import argparse
import getpass
import json
import os
import re
import shutil
import ssl
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

API_PREFIX = "/it4788/api/v1"

# python.org builds on macOS ship without CA certs; use certifi's bundle when available.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

# Cloudflare in front of the server rejects urllib's default "Python-urllib" User-Agent (403).
_opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=SSL_CTX))
_opener.addheaders = [("User-Agent", "horus-download-script/1.0")]
urllib.request.install_opener(_opener)


def call(base, path, token=None, body=None):
    req = urllib.request.Request(
        base + API_PREFIX + path,
        data=json.dumps(body).encode() if body is not None else None,
        method="POST" if body is not None else "GET",
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            payload = json.load(res)
    except urllib.error.HTTPError as e:  # server puts the reason in a JSON body
        try:
            payload = json.load(e)
        except ValueError:
            raise RuntimeError(f"{path}: HTTP {e.code}") from None
    if payload.get("code") != 1000:
        if path == "/auth/login":
            sys.exit(f"Đăng nhập thất bại: {payload.get('message')} (kiểm tra email/mật khẩu)")
        raise RuntimeError(f"{path}: {payload.get('code')} {payload.get('message')}")
    return payload["data"]


def safe(text):
    return re.sub(r"[^\w.-]+", "-", text or "").strip("-") or "camera"


VN_TZ = timezone(timedelta(hours=7))


def vn_time(created_at, fmt):
    """Server timestamps are UTC; format them in Vietnam time (UTC+7)."""
    if not created_at:
        return "unknown-time"
    dt = datetime.fromisoformat(created_at.replace("Z", "+00:00").replace(" ", "T"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(VN_TZ).strftime(fmt)


def pick(videos):
    """Print a numbered list and return the clips the user picks."""
    for n, v in enumerate(videos, 1):
        when = vn_time(v.get("created_at"), "%Y-%m-%d %H:%M:%S")
        mb = (v.get("size") or 0) / 1e6
        secs = (v.get("duration_ms") or 0) // 1000
        print(f"{n:>4}. {when}  {v.get('camera_name') or '?':<20} {secs // 60:>3}:{secs % 60:02d}  "
              f"{mb:>7.1f} MB  {v.get('name') or ''}")
    while True:
        raw = input("Chọn video cần tải (vd 1,3,5-8 | all | Enter để huỷ): ").strip().lower()
        if not raw:
            return []
        if raw in ("all", "a", "tatca"):
            return videos
        chosen = set()
        try:
            for part in raw.replace(" ", "").split(","):
                if "-" in part:
                    lo, hi = map(int, part.split("-", 1))
                    chosen.update(range(lo, hi + 1))
                elif part:
                    chosen.add(int(part))
        except ValueError:
            print("Không hiểu, nhập lại dạng 1,3,5-8")
            continue
        bad = [n for n in chosen if not 1 <= n <= len(videos)]
        if bad:
            print(f"Số ngoài khoảng 1-{len(videos)}: {sorted(bad)}")
            continue
        return [videos[n - 1] for n in sorted(chosen)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="e.g. https://cam.whiteou7.id.vn")
    ap.add_argument("--email", "--phone", dest="phone", required=True,
                    help="Controller account email or phone number")
    ap.add_argument("--out", default="videos", help="output folder (default: videos)")
    ap.add_argument("--session", help="only clips of this recording session id")
    ap.add_argument("--chon", "--select", dest="select", action="store_true",
                    help="show the list and pick which clips to download (e.g. 1,3,5-8 or all)")
    args = ap.parse_args()

    base = args.server.rstrip("/")
    password = os.environ.get("MULTICAM_PASSWORD") or getpass.getpass("Password: ")
    def do_login():
        data = call(base, "/auth/login", body={
            "phone": args.phone,
            "password": password,
            "device_id": f"download-script-{uuid.getnode():x}",
            "device_type": 4,
            "device_name": "download script",
        })
        if data.get("account_role") != "controller":
            sys.exit("Need a Controller account: only Controllers can download videos.")
        return data["access_token"], time.time()

    # access token lives ~15 min: log in again before it runs out on long downloads
    token, logged_at = do_login()

    videos, index = [], 0
    while True:
        query = {"index": index, "count": 100, "sort": "created_at_asc"}
        if args.session:
            query["session_id"] = args.session
        page = call(base, "/videos?" + urllib.parse.urlencode(query), token)["videos"]
        videos += page
        if len(page) < 100:
            break
        index += 100
    print(f"{len(videos)} video(s) on server")

    if args.select and videos:
        videos = pick(videos)
        if not videos:
            sys.exit("Không chọn video nào.")

    os.makedirs(args.out, exist_ok=True)
    failed = 0
    for i, v in enumerate(videos, 1):
        stamp = vn_time(v.get("created_at"), "%Y-%m-%d_%H-%M-%S")
        name = f"{stamp}_{safe(v.get('camera_name'))}_{v['id'][:8]}.mp4"
        path = os.path.join(args.out, name)
        if os.path.exists(path) and os.path.getsize(path) == v.get("size"):
            print(f"[{i}/{len(videos)}] skip {name}")
            continue
        try:
            if time.time() - logged_at > 600:
                token, logged_at = do_login()
            url = call(base, f"/videos/{v['id']}/download", token)["download_url"]
            print(f"[{i}/{len(videos)}] {name} ({(v.get('size') or 0) / 1e6:.1f} MB)")
            tmp = path + ".part"
            with urllib.request.urlopen(url, timeout=60) as res, open(tmp, "wb") as f:
                shutil.copyfileobj(res, f, 1024 * 1024)
            os.replace(tmp, path)
        except Exception as e:  # keep going; report at the end
            failed += 1
            print(f"  failed: {e}")
    print(f"done, {len(videos) - failed} ok, {failed} failed -> {os.path.abspath(args.out)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
