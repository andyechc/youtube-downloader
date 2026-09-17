#!/usr/bin/env python3
"""Descargador de videos de YouTube por CLI usando yt-dlp (modo guiado)."""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yt_dlp

# termios/tty/select son POSIX. En Windows no existen: el CLI usa el modo
# numerado (sin flechas) y sin tecla de cancelado rápido (usa Ctrl+C).
try:
    import select
    import termios
    import tty
    HAS_TERMIOS = True
except ImportError:  # Windows
    select = None  # type: ignore
    termios = None  # type: ignore
    tty = None  # type: ignore
    HAS_TERMIOS = False

DEFAULT_DIR = Path.home() / "Downloads" / "YT"
QUALITIES = ["best", "1080", "720", "480", "360"]

BOLD = "\033[1m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"
ORANGE = "\033[38;5;208m"
RESET = "\033[0m"

USE_COLOR = sys.stdout.isatty()


def paint(text: str, color: str = "", bold: bool = False) -> str:
    if not USE_COLOR:
        return text
    style = (BOLD if bold else "") + color
    return f"{style}{text}{RESET}" if style else text


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
        cands = [
            f for f in fmts
            if f.get("acodec") and f.get("acodec") != "none"
            and (not f.get("vcodec") or f.get("vcodec") == "none")
        ]
        if not cands:
            cands = [f for f in fmts if f.get("acodec") and f.get("acodec") != "none"]
    else:
        cap = int(quality) if quality.isdigit() else 99999
        cands = [
            f for f in fmts
            if f.get("vcodec") and f.get("vcodec") != "none"
            and (f.get("height") or 0) <= cap and f.get("height")
        ]

    if not cands:
        return None, False

    cands.sort(key=lambda f: ((f.get("height") or 0), (f.get("tbr") or 0)), reverse=True)
    chosen = cands[0]
    size = _format_size(chosen, duration)
    estimated = bool(size) and not (chosen.get("filesize") or chosen.get("filesize_approx"))

    if audio or (chosen.get("acodec") and chosen.get("acodec") != "none"):
        return size, estimated

    audio_cands = [
        f for f in fmts
        if f.get("acodec") and f.get("acodec") != "none"
        and (not f.get("vcodec") or f.get("vcodec") == "none")
    ]
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
    for runtime in ("deno", "node", "bun"):
        if shutil.which(runtime):
            return runtime
    return None


def find_browser_cookies() -> str | None:
    from yt_dlp.cookies import extract_cookies_from_browser

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
        "quiet": False,
        "no_warnings": False,
        "restrictfilenames": True,
        "ignoreerrors": True,
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
    opts["outtmpl"] = str(out_dir / "%(title)s [%(id)s].%(ext)s")
    opts["concurrent_fragment_downloads"] = 8
    opts["buffersize"] = 1024 * 16
    opts["socket_timeout"] = 30
    if audio:
        opts.update(
            {
                "format": "bestaudio/best",
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": "320",
                    }
                ],
            }
        )
    else:
        opts["format"] = resolve_quality(quality) + "/best"
    return opts


def pick_folder_via_finder() -> Path | None:
    script = 'POSIX path of (choose folder with prompt "Selecciona la carpeta de descarga")'
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
    path = Path(result.stdout.strip())
    return path if path.is_dir() else None


def _read_key() -> str:
    fd = sys.stdin.fileno()
    ch = os.read(fd, 1).decode("utf-8", "replace")
    if ch == "\x03":
        raise KeyboardInterrupt
    if ch == "\x1b":
        seq = os.read(fd, 2).decode("utf-8", "replace")
        if seq == "[A":
            return "up"
        if seq == "[B":
            return "down"
        return "esc"
    return ch


def arrow_menu(title: str, choices: list[str], default: int = 0) -> int:
    if not sys.stdin.isatty() or not HAS_TERMIOS:
        print(title)
        for i, c in enumerate(choices):
            print(f"  {i + 1}) {c}")
        while True:
            try:
                n = int(input(f"Opción [default {default + 1}]: ").strip() or default + 1)
                if 1 <= n <= len(choices):
                    return n - 1
            except ValueError:
                pass
            print("[!] Opción no válida.")

    idx = default
    menu_height = len(choices) + 1
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)

    def menu_top(rows: int) -> int:
        return max(1, rows - menu_height)

    def render(rows: int) -> None:
        sys.stdout.write(f"\033[{menu_top(rows)};1H\033[J")
        lines = [paint(title, CYAN, bold=True) + paint("  (↑/↓ + Enter)", DIM)]
        for i, c in enumerate(choices):
            if i == idx:
                lines.append(f"  {paint('>', ORANGE, bold=True)} {paint(c, ORANGE, bold=True)}")
            else:
                lines.append(f"  {paint(c, ORANGE)}")
        sys.stdout.write("\r\n".join(lines) + "\r\n")
        sys.stdout.flush()

    try:
        tty.setraw(fd)
        _, rows = shutil.get_terminal_size((80, 24))
        render(rows)
        while True:
            key = _read_key()
            if key == "up":
                idx = (idx - 1) % len(choices)
                render(rows)
            elif key == "down":
                idx = (idx + 1) % len(choices)
                render(rows)
            elif key in ("\r", "\n"):
                sys.stdout.write(f"\033[{menu_top(rows)};1H\033[J")
                sys.stdout.flush()
                return idx
    except (termios.error, OSError):
        return default
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def ask_url() -> str:
    while True:
        url = input("\nEnlace del video o playlist: ").strip()
        if url:
            return url
        print("[!] El enlace no puede estar vacío.")


def fetch_preview(url: str, quality: str, audio: bool) -> dict:
    opts = base_opts()
    opts["outtmpl"] = str(Path.home() / ".yt_preview" / "%(id)s.%(ext)s")
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


def render_preview(info: dict, quality: str, audio: bool) -> None:
    def fmt(info: dict) -> str:
        size, estimated = estimate_size(info, quality, audio)
        return ("~" if estimated else "") + human_size(size)

    if info.get("_type") == "playlist":
        print(paint(f"  ▶ Playlist: {info.get('title', '?')}", CYAN, bold=True))
        print(paint(f"    ({info.get('playlist_count', '?')} videos)", DIM))
        total = 0
        for i, entry in enumerate(info.get("entries") or [], start=1):
            if not entry:
                continue
            title = entry.get("title") or "?"
            size, estimated = estimate_size(entry, quality, audio)
            if size:
                total += size
            shown = ("~" if estimated else "") + human_size(size)
            print(f"  {paint(str(i) + '.', GREEN, bold=True)} {title[:60]}")
            print(
                f"      {paint('Tamaño:', YELLOW)} {shown}"
                f"  |  {paint('Duración:', YELLOW)} {fmt_duration(entry.get('duration'))}"
            )
        print(
            f"  {paint('TOTAL:', BOLD)}{paint(' ' + human_size(total) if total else ' desconocido', GREEN, bold=True)}"
        )
    else:
        print(f"  {paint('Título  :', CYAN, bold=True)} {info.get('title', '?')}")
        print(f"  {paint('Duración:', CYAN, bold=True)} {fmt_duration(info.get('duration'))}")
        print(f"  {paint('Tamaño  :', CYAN, bold=True)} {paint(fmt(info), GREEN, bold=True)}")


def show_preview(url: str, quality: str, audio: bool) -> None:
    print(paint("  Obteniendo información del video...", DIM))
    info = fetch_preview(url, quality, audio)
    render_preview(info, quality, audio)


def guided_flow() -> int:
    print()
    print(paint("  ╔══════════════════════════════════════════╗", CYAN, bold=True))
    print(paint("  ║      YouTube Downloader — modo guiado    ║", CYAN, bold=True))
    print(paint("  ╚══════════════════════════════════════════╝", CYAN, bold=True))
    print()

    while True:
        url = ask_url()
        q_idx = arrow_menu(
            "Calidad del video:",
            ["best (máxima)", "1080p", "720p", "480p", "360p"],
            default=0,
        )
        quality = QUALITIES[q_idx]

        a_idx = arrow_menu(
            "Tipo de descarga:",
            ["Video (video + audio)", "Solo audio (MP3)"],
            default=0,
        )
        audio = a_idx == 1

        f_idx = arrow_menu(
            "Carpeta de destino:",
            ["~/Downloads/YT (predeterminada)", "Elegir carpeta (Finder)"],
            default=0,
        )
        if f_idx == 0:
            out_dir = DEFAULT_DIR
        else:
            out_dir = pick_folder_via_finder()
            if out_dir is None:
                manual = input("No se pudo abrir el Finder. Escribe la ruta: ").strip()
                out_dir = Path(manual).expanduser() if manual else DEFAULT_DIR
        out_dir = out_dir.expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)

        show_preview(url, quality, audio)

        print(f"\n  {paint('Destino  :', CYAN, bold=True)} {out_dir}")
        quality_line = f"  {paint('Calidad  :', CYAN, bold=True)} {quality}"
        if audio:
            quality_line += paint("  (solo audio MP3)", YELLOW)
        print(quality_line)
        c_idx = arrow_menu("¿Descargar?", ["Sí, descargar", "No, cancelar"], default=0)
        if c_idx == 0:
            download(url, out_dir, quality, audio)

        again = arrow_menu("¿Otra descarga?", ["Sí, descargar otro video", "No, salir"], default=0)
        if again != 0:
            print(paint("  ¡Hasta luego!", CYAN, bold=True))
            return 0


def cancel_pressed() -> bool:
    if not HAS_TERMIOS or not sys.stdin.isatty():
        return False
    fd = sys.stdin.fileno()
    try:
        r, _, _ = select.select([fd], [], [], 0)
        if not r:
            return False
        data = os.read(fd, 4096)
    except (OSError, ValueError):
        return False
    return any(ch in ("q", "Q", "\x1b", "\x03") for ch in data.decode("utf-8", "ignore"))


def cleanup_files(out_dir: Path, before: set[str], tracked: set[Path], delete_tracked: bool) -> None:
    for p in tracked:
        if not delete_tracked:
            continue
        base = Path(p.name)
        try:
            if p.exists():
                p.unlink()
        except OSError:
            pass
        for suffix in (".part", ".ytdl", ".temp"):
            for candidate in out_dir.glob(base.name + suffix + "*"):
                try:
                    candidate.unlink()
                except OSError:
                    pass
    for p in out_dir.iterdir():
        if p.name in before:
            continue
        if any(marker in p.name for marker in (".part", ".ytdl", ".temp")):
            try:
                p.unlink()
            except OSError:
                pass


def download(url: str, out_dir: Path, quality: str, audio: bool) -> int:
    before = {p.name for p in out_dir.iterdir()} if out_dir.exists() else set()
    tracked: set[Path] = set()
    cancelled = {"flag": False}

    def hook(d: dict) -> None:
        fname = d.get("filename")
        if fname:
            tracked.add(Path(fname))
        if cancel_pressed():
            cancelled["flag"] = True
            raise yt_dlp.utils.DownloadCancelled()

    opts = build_opts(url, out_dir, quality, audio)
    opts["progress_hooks"] = [hook]

    fd = sys.stdin.fileno()
    old = None
    result = 0
    try:
        if HAS_TERMIOS and sys.stdin.isatty():
            old = termios.tcgetattr(fd)
            tty.setcbreak(fd)
            print(paint("  [Q / ESC / Ctrl+C] para cancelar", DIM))
        elif sys.stdin.isatty():
            print(paint("  [Ctrl+C] para cancelar", DIM))
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except yt_dlp.utils.DownloadCancelled:
        cancelled["flag"] = True
    except KeyboardInterrupt:
        cancelled["flag"] = True
    except yt_dlp.utils.DownloadError as exc:
        print(f"[ERROR] No se pudo descargar: {exc}", file=sys.stderr)
        result = 1
        cleanup_files(out_dir, before, tracked, delete_tracked=False)
    except Exception as exc:
        print(f"[ERROR] Inesperado: {exc}", file=sys.stderr)
        result = 1
        cleanup_files(out_dir, before, tracked, delete_tracked=False)
    finally:
        if old:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)

    if cancelled["flag"]:
        cleanup_files(out_dir, before, tracked, delete_tracked=True)
        print(paint("  Descarga cancelada. Archivos parciales eliminados.", YELLOW))
        return 1
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="youtube-downloader",
        description="Descarga videos (o solo audio) de YouTube. Sin argumentos entra en modo guiado.",
    )
    parser.add_argument("url", nargs="?", help="URL del video o playlist de YouTube")
    parser.add_argument(
        "-o", "--output", default=str(DEFAULT_DIR),
        help=f"Carpeta donde se guarda el archivo (default: {DEFAULT_DIR})",
    )
    parser.add_argument(
        "-a", "--audio", action="store_true",
        help="Descargar solo el audio en MP3 (320kbps)",
    )
    parser.add_argument(
        "-q", "--quality", default="best",
        help="Calidad: best, 1080, 720, 480, 360 (default: best)",
    )
    return parser


def cli_flow(args: argparse.Namespace) -> int:
    out_dir = Path(args.output).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    return download(args.url, out_dir, args.quality, args.audio)


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.url:
            return cli_flow(args)
        return guided_flow()
    except KeyboardInterrupt:
        print(paint("\n  Interrumpido.", YELLOW))
        return 130


if __name__ == "__main__":
    sys.exit(main())