#!/usr/bin/env python3
"""Web server local para YouTube Downloader — stdlib only + yt-dlp.
Sirve la UI moderna en /web y expone API JSON para preview/descarga.
Compatible con despliegue local y Vercel (via adaptador).
"""
import argparse
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from pathlib import Path
from urllib.parse import urlparse, parse_qs

try:
    import yt_dlp
except ImportError:
    print("[server] yt-dlp no instalado. Ejecuta: pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ROOT = Path(__file__).parent
WEB_DIR = ROOT / "web"
# Carpeta de descargas: configurable vía YT_OUT_DIR (útil en Docker).
DEFAULT_DIR = Path(os.environ.get("YT_OUT_DIR") or (Path.home() / "Downloads" / "YT"))
QUALITIES = ["best", "1080", "720", "480", "360"]
SEARCH_PER_PAGE = 20

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Helpers copiados de youtube-downloader.py (sin dependencia circular)
# ---------------------------------------------------------------------------
def _format_size(f: dict, duration: int | None) -> int | None:
    known = f.get("filesize") or f.get("filesize_approx")
    if known:
        return known
    bitrate = f.get("tbr") or f.get("abr")
    if bitrate and duration:
        return bitrate * 1000 / 8 * duration
    return None

def estimate_size(info: dict, quality: str, audio: bool) -> tuple[int | None, bool]:
    fmts = info.get("formats") or []
    duration = info.get("duration")
    if not fmts:
        return None, False
    if audio:
        cands = [f for f in fmts if f.get("acodec") and f.get("acodec") != "none" and (not f.get("vcodec") or f.get("vcodec") == "none")]
        if not cands:
            cands = [f for f in fmts if f.get("acodec") and f.get("acodec") != "none"]
    else:
        cap = int(quality) if quality.isdigit() else 99999
        cands = [f for f in fmts if f.get("vcodec") and f.get("vcodec") != "none" and (f.get("height") or 0) <= cap and f.get("height")]
    if not cands:
        return None, False
    cands.sort(key=lambda f: ((f.get("height") or 0), (f.get("tbr") or 0)), reverse=True)
    chosen = cands[0]
    size = _format_size(chosen, duration)
    estimated = bool(size) and not (chosen.get("filesize") or chosen.get("filesize_approx"))
    if audio or (chosen.get("acodec") and chosen.get("acodec") != "none"):
        return size, estimated
    audio_cands = [f for f in fmts if f.get("acodec") and f.get("acodec") != "none" and (not f.get("vcodec") or f.get("vcodec") == "none")]
    audio_sizes = [_format_size(f, duration) for f in audio_cands]
    audio_sizes = [s for s in audio_sizes if s]
    audio_size = max(audio_sizes) if audio_sizes else None
    if size and audio_size:
        return size + audio_size, estimated
    return size or audio_size, estimated

def human_size(num: int | None) -> str:
    if not num:
        return "desconocido"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024:
            return f"{num:.1f} {unit}" if unit != "B" else f"{int(num)} B"
        num /= 1024
    return f"{num:.1f} PB"

def fmt_duration(secs: int | None) -> str:
    if not secs:
        return "?"
    m, s = divmod(int(secs), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

def find_js_runtime() -> str | None:
    for rt in ("deno", "node", "bun"):
        if shutil.which(rt):
            return rt
    return None

def find_browser_cookies() -> str | None:
    try:
        from yt_dlp.cookies import extract_cookies_from_browser
    except Exception:
        return None
    for browser in ("safari", "chrome", "brave", "edge", "firefox"):
        try:
            jar = extract_cookies_from_browser(browser)
            if jar:
                return browser
        except Exception:
            continue
    return None

def base_opts() -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": False,
        "ignoreerrors": True,
        "noplaylist": False,
    }
    runtime = find_js_runtime()
    if runtime:
        opts["js_runtimes"] = {runtime: {}}
        opts["remote_components"] = {"ejs:github"}
    browser = find_browser_cookies()
    if browser:
        opts["cookiesfrombrowser"] = (browser,)
    return opts

def resolve_quality(quality: str) -> str:
    if quality.isdigit():
        return f"bestvideo[height<={quality}]+bestaudio/best"
    return "bestvideo+bestaudio/best"

def build_opts(url: str, out_dir: Path, quality: str, audio: bool) -> dict:
    opts = base_opts()
    opts["quiet"] = False
    opts["no_warnings"] = False
    opts["outtmpl"] = str(out_dir / "%(title)s [%(id)s].%(ext)s")
    opts["concurrent_fragment_downloads"] = 8
    opts["buffersize"] = 1024 * 16
    opts["socket_timeout"] = 30
    if audio:
        opts.update({
            "format": "bestaudio/best",
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "320"}],
        })
    else:
        opts["format"] = resolve_quality(quality) + "/best"
    return opts

def best_thumbnail(info: dict) -> str | None:
    if info.get("thumbnail"):
        return info["thumbnail"]
    thumbs = info.get("thumbnails") or []
    if thumbs:
        # prefer highest resolution
        try:
            thumbs_sorted = sorted(thumbs, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
            return thumbs_sorted[-1].get("url")
        except Exception:
            return thumbs[-1].get("url")
    return None

def search_youtube(query: str, page: int = 1, per_page: int = SEARCH_PER_PAGE) -> dict:
    """Busca videos en YouTube usando yt-dlp y devuelve lista normalizada."""
    # yt-dlp's ytsearch doesn't support playliststart/playlistend for pagination
    # So we fetch up to page * per_page + 1 results to determine has_more
    total_needed = page * per_page + 1
    search_query = f"ytsearch{total_needed}:{query}"
    opts = base_opts()
    opts["extract_flat"] = "in_playlist"
    with yt_dlp.YoutubeDL(opts) as ydl:
        result = ydl.extract_info(search_query, download=False)
    entries = result.get("entries") or []
    # Slice for current page
    start = (page - 1) * per_page
    end = start + per_page
    page_entries = entries[start:end]
    has_more = len(entries) > end
    videos = []
    for e in page_entries:
        if not e:
            continue
        videos.append({
            "id": e.get("id"),
            "title": e.get("title") or "Sin título",
            "channel": e.get("channel") or e.get("uploader") or "?",
            "duration": e.get("duration"),
            "duration_str": fmt_duration(e.get("duration")),
            "thumbnail": best_thumbnail(e),
            "view_count": e.get("view_count"),
            "upload_date": e.get("upload_date"),
            "url": e.get("webpage_url") or e.get("url") or f"https://www.youtube.com/watch?v={e.get('id')}",
        })
    return {
        "query": query,
        "page": page,
        "per_page": per_page,
        "results": videos,
        "has_more": has_more,
    }


def sanitize_info(info: dict, quality: str, audio: bool) -> dict:
    """Convierte info cruda de yt-dlp en payload liviano para el frontend."""
    if info.get("_type") == "playlist":
        entries = []
        total_size = 0
        for e in (info.get("entries") or [])[:50]:  # limit to 50 for payload
            if not e:
                continue
            sz, est = estimate_size(e, quality, audio)
            if sz:
                total_size += sz
            entries.append({
                "id": e.get("id"),
                "title": e.get("title") or "Sin título",
                "duration": e.get("duration"),
                "duration_str": fmt_duration(e.get("duration")),
                "thumbnail": best_thumbnail(e),
                "channel": e.get("channel") or e.get("uploader") or "?",
                "size": sz,
                "size_str": ( "~" if est else "") + human_size(sz),
                "estimated": est,
                "url": e.get("webpage_url") or e.get("url") or f"https://www.youtube.com/watch?v={e.get('id')}",
            })
        return {
            "type": "playlist",
            "title": info.get("title") or "Playlist",
            "uploader": info.get("uploader") or info.get("channel") or "?",
            "count": info.get("playlist_count") or len(entries),
            "thumbnail": best_thumbnail(info) or (entries[0]["thumbnail"] if entries else None),
            "entries": entries,
            "total_size": total_size,
            "total_size_str": human_size(total_size) if total_size else "desconocido",
            "description": (info.get("description") or "")[:600],
        }
    else:
        sz, est = estimate_size(info, quality, audio)
        return {
            "type": "video",
            "id": info.get("id"),
            "title": info.get("title") or "Sin título",
            "channel": info.get("channel") or info.get("uploader") or "?",
            "uploader": info.get("uploader") or info.get("channel") or "?",
            "duration": info.get("duration"),
            "duration_str": fmt_duration(info.get("duration")),
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "upload_date": info.get("upload_date"),
            "thumbnail": best_thumbnail(info),
            "description": (info.get("description") or "")[:800],
            "webpage_url": info.get("webpage_url"),
            "size": sz,
            "size_str": ("~" if est else "") + human_size(sz),
            "estimated": est,
            "width": info.get("width"),
            "height": info.get("height"),
            "fps": info.get("fps"),
            "ext": info.get("ext"),
        }

# ---------------------------------------------------------------------------
# Job worker
# ---------------------------------------------------------------------------
def download_worker(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        job["status"] = "downloading"
        job["progress"] = 0
        job["started_at"] = time.time()

    url = job["url"]
    quality = job["quality"]
    audio = job["audio"]
    out_dir = Path(job["out_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    tracked_files: list[str] = []

    def hook(d: dict):
        with jobs_lock:
            j = jobs.get(job_id)
            if not j:
                return
            if j.get("cancelled"):
                raise yt_dlp.utils.DownloadCancelled("Cancelled by user")
            fname = d.get("filename")
            if fname and fname not in tracked_files:
                tracked_files.append(fname)
                # try to keep latest filename
                j["current_filename"] = fname
            status = d.get("status")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes") or 0
                j["downloaded_bytes"] = downloaded
                j["total_bytes"] = total
                if total:
                    j["progress"] = min(99, round(downloaded / total * 100, 1))
                else:
                    # fallback to percent string
                    pct = d.get("_percent_str") or ""
                    try:
                        j["progress"] = float(pct.strip().replace("%","")) if pct else j["progress"]
                    except: pass
                j["speed"] = d.get("_speed_str") or ""
                j["eta"] = d.get("_eta_str") or ""
                # also store raw
                j["speed_raw"] = d.get("speed")
                j["eta_raw"] = d.get("eta")
            elif status == "finished":
                j["progress"] = 100
                j["status"] = "processing"
                j["speed"] = ""
                j["eta"] = ""

    opts = build_opts(url, out_dir, quality, audio)
    opts["progress_hooks"] = [hook]
    # also capture info for title
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            # need to handle cancellation
            ydl.download([url])
        # After download, enumerate new files
        files = []
        for f in tracked_files:
            # audio conversion changes extension to mp3
            p = Path(f)
            # check if mp3 exists instead
            if audio and p.suffix != ".mp3":
                mp3_guess = p.with_suffix(".mp3")
                if mp3_guess.exists():
                    p = mp3_guess
            if p.exists():
                files.append(str(p))
                job["current_filename"] = str(p)
        # fallback: list dir by recent mtime if hook missed
        if not files:
            # list newest files in out_dir modified within last 5 minutes
            candidates = sorted(out_dir.iterdir(), key=lambda x: x.stat().st_mtime if x.exists() else 0, reverse=True)
            for c in candidates[:5]:
                if c.is_file() and time.time() - c.stat().st_mtime < 600:
                    files.append(str(c))
                    break
        with jobs_lock:
            j = jobs.get(job_id)
            if j:
                if j.get("cancelled"):
                    j["status"] = "cancelled"
                else:
                    j["status"] = "done"
                    j["progress"] = 100
                    j["files"] = files
                    j["finished_at"] = time.time()
                    # try to get title from first file
                    if files:
                        j["result_file"] = files[0]
    except yt_dlp.utils.DownloadCancelled:
        with jobs_lock:
            j = jobs.get(job_id)
            if j:
                j["status"] = "cancelled"
                j["error"] = "Descarga cancelada"
    except Exception as e:
        with jobs_lock:
            j = jobs.get(job_id)
            if j:
                j["status"] = "error"
                j["error"] = str(e)[:500]
                j["progress"] = 0
    # handle partial cleanup if cancelled
    with jobs_lock:
        j = jobs.get(job_id)
        if j and j.get("status") == "cancelled":
            for f in tracked_files:
                for suffix in ("", ".part", ".ytdl", ".temp"):
                    try:
                        cand = Path(f + suffix) if suffix else Path(f)
                        if cand.exists():
                            cand.unlink(missing_ok=True)
                    except: pass

# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # limit log noise but keep useful
        sys.stderr.write(f"[{self.log_date_time_string()}] {format%args}\n")

    def send_json(self, data, status=200, headers=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if headers:
            for k,v in headers.items():
                self.send_header(k,v)
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, content_type="text/plain", status=200):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_HEAD(self):
        # Soporte HEAD para /api/file y health checks (evita 501)
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/file/") or path in ("/api/health", "/api/jobs", "/api/list_files", "/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json" if path.startswith("/api/") else "text/html")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        # API routes
        if path == "/api/health":
            return self.send_json({"ok": True, "version": "1.0", "yt_dlp": getattr(yt_dlp.version, "__version__", "?")})
        if path == "/api/jobs":
            with jobs_lock:
                lst = list(jobs.values())
                # copy shallow, ensure Path -> str
                # filter sensitive
            return self.send_json({"jobs": lst})
        if path == "/api/progress":
            job_id = qs.get("jobId", qs.get("id", [None]))[0]
            if not job_id or job_id not in jobs:
                return self.send_json({"error": "job no encontrado"}, status=404)
            with jobs_lock:
                j = jobs[job_id].copy()
            return self.send_json(j)
        if path.startswith("/api/file/"):
            job_id = path[len("/api/file/"):]
            with jobs_lock:
                j = jobs.get(job_id)
            if not j or not j.get("files"):
                return self.send_json({"error": "archivo no disponible"}, status=404)
            # serve first file, or ?index=
            idx = 0
            try:
                idx = int(qs.get("idx", ["0"])[0])
            except: pass
            files = j.get("files") or []
            if idx < 0 or idx >= len(files):
                return self.send_json({"error": "indice fuera de rango"}, status=404)
            fpath = Path(files[idx])
            if not fpath.exists() or not fpath.is_file():
                return self.send_json({"error": "archivo no encontrado en disco"}, status=404)
            # stream file
            try:
                ctype, _ = mimetypes.guess_type(str(fpath))
                ctype = ctype or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Disposition", f'attachment; filename="{fpath.name}"')
                self.send_header("Content-Length", str(fpath.stat().st_size))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with open(fpath, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            except Exception as e:
                return self.send_json({"error": str(e)}, status=500)
        if path == "/api/list_files":
            # list files in downloads folder
            out_dir = DEFAULT_DIR
            qs_out = qs.get("dir", [None])[0]
            if qs_out:
                out_dir = Path(qs_out).expanduser()
            files = []
            if out_dir.exists():
                for p in sorted(out_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True)[:100]:
                    if p.is_file():
                        files.append({"name": p.name, "size": p.stat().st_size, "size_str": human_size(p.stat().st_size), "path": str(p), "mtime": p.stat().st_mtime})
            return self.send_json({"dir": str(out_dir), "files": files})

        # Static files
        # Normalize path
        if path == "/":
            path = "/index.html"
        # prevent directory traversal
        safe_path = Path(path.lstrip("/"))
        # Handle paths like /assets/...
        file_path = WEB_DIR / safe_path
        # if path doesn't include extension and not found, try index
        if file_path.is_dir():
            file_path = file_path / "index.html"
        if not file_path.exists():
            # fallback to index.html for SPA? but we are not SPA, 404
            # try to serve index.html for unknown routes that expect html?
            if path.startswith("/api/"):
                return self.send_json({"error": "not found"}, status=404)
            return self.send_text("404 Not Found", status=404)
        # check that file is inside WEB_DIR
        try:
            file_path.resolve().relative_to(WEB_DIR.resolve())
        except ValueError:
            return self.send_text("403 Forbidden", status=403)
        ctype, _ = mimetypes.guess_type(str(file_path))
        if ctype is None:
            ctype = "application/octet-stream"
        # extra for css/js
        if file_path.suffix == ".css":
            ctype = "text/css"
        elif file_path.suffix == ".js":
            ctype = "application/javascript"
        try:
            data = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            # cache control for static
            if file_path.suffix in (".css", ".js", ".svg", ".png", ".jpg"):
                self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_text(f"Error leyendo archivo: {e}", status=500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {}

        if path == "/api/preview":
            url = (body.get("url") or "").strip()
            if not url:
                return self.send_json({"error": "URL vacía"}, status=400)
            quality = body.get("quality") or "best"
            if quality not in QUALITIES:
                quality = "best"
            audio = bool(body.get("audio"))
            try:
                opts = base_opts()
                # minimal opts for preview
                opts["noplaylist"] = False
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                payload = sanitize_info(info, quality, audio)
                return self.send_json({"ok": True, "info": payload, "quality": quality, "audio": audio})
            except Exception as e:
                # yt-dlp may throw DownloadError with message
                msg = str(e)[:800]
                return self.send_json({"ok": False, "error": msg}, status=422)

        if path == "/api/search":
            query = (body.get("query") or "").strip()
            if not query:
                return self.send_json({"error": "Query vacía"}, status=400)
            page = int(body.get("page") or 1)
            per_page = int(body.get("per_page") or SEARCH_PER_PAGE)
            if per_page > 50:
                per_page = 50
            if page < 1:
                page = 1
            try:
                data = search_youtube(query, page, per_page)
                return self.send_json({"ok": True, **data})
            except Exception as e:
                msg = str(e)[:800]
                return self.send_json({"ok": False, "error": msg}, status=422)

        if path == "/api/download":
            url = (body.get("url") or "").strip()
            if not url:
                return self.send_json({"error": "URL vacía"}, status=400)
            quality = body.get("quality") or "best"
            audio = bool(body.get("audio"))
            out_dir_str = body.get("outDir") or str(DEFAULT_DIR)
            out_dir = Path(out_dir_str).expanduser()
            # validate quality
            if quality not in QUALITIES:
                quality = "best"
            job_id = uuid.uuid4().hex[:12]
            job = {
                "id": job_id,
                "url": url,
                "quality": quality,
                "audio": audio,
                "out_dir": str(out_dir),
                "status": "queued",
                "progress": 0,
                "downloaded_bytes": 0,
                "total_bytes": None,
                "speed": "",
                "eta": "",
                "files": [],
                "current_filename": None,
                "error": None,
                "cancelled": False,
                "created_at": time.time(),
            }
            with jobs_lock:
                jobs[job_id] = job
            # start thread
            t = threading.Thread(target=download_worker, args=(job_id,), daemon=True)
            t.start()
            return self.send_json({"ok": True, "jobId": job_id, "job": job})

        if path.startswith("/api/cancel/"):
            job_id = path[len("/api/cancel/"):]
            with jobs_lock:
                j = jobs.get(job_id)
                if not j:
                    return self.send_json({"error": "job no encontrado"}, status=404)
                j["cancelled"] = True
                # if queued, mark cancelled
                if j["status"] in ("queued", "downloading", "processing"):
                    j["status"] = "cancelled"
            return self.send_json({"ok": True})

        # unknown POST
        return self.send_json({"error": "endpoint no encontrado"}, status=404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/jobs/"):
            job_id = parsed.path[len("/api/jobs/"):]
            with jobs_lock:
                if job_id in jobs:
                    del jobs[job_id]
                    return self.send_json({"ok": True})
                else:
                    return self.send_json({"error": "no encontrado"}, status=404)
        return self.send_json({"error": "not found"}, status=404)

class ThreadedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def run(host="127.0.0.1", port=8000):
    # ensure web dir exists
    if not WEB_DIR.exists():
        print(f"[error] No se encontró {WEB_DIR}. Crea la carpeta web/ con index.html", file=sys.stderr)
        sys.exit(1)
    server_address = (host, port)
    httpd = ThreadedServer(server_address, Handler)
    print(f"  ╔════════════════════════════════════════════╗")
    print(f"  ║   YT Downloader Web — http://{host}:{port}   ║")
    print(f"  ╚════════════════════════════════════════════╝")
    print(f"  • UI: http://{host}:{port}/")
    print(f"  • API health: http://{host}:{port}/api/health")
    print(f"  • Carpeta descargas: {DEFAULT_DIR}")
    print(f"  • Presiona Ctrl+C para detener\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Deteniendo servidor...")
        httpd.shutdown()

def build_parser():
    p = argparse.ArgumentParser(description="Servidor web local para YT Downloader (sin dependencias)")
    p.add_argument("--host", default="127.0.0.1", help="Host (default 127.0.0.1, usa 0.0.0.0 para red local)")
    p.add_argument("--port", type=int, default=8000, help="Puerto (default 8000)")
    p.add_argument("--open", action="store_true", help="Abrir navegador automáticamente")
    return p

if __name__ == "__main__":
    args = build_parser().parse_args()
    if args.open:
        import webbrowser
        threading.Timer(0.8, lambda: webbrowser.open(f"http://{args.host if args.host!='0.0.0.0' else '127.0.0.1'}:{args.port}")).start()
    run(args.host, args.port)
