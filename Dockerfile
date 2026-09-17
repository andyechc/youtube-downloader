# YT Downloader — servidor web + API (yt-dlp) en un contenedor.
# Uso: docker compose up --build  →  http://localhost:8000
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # yt-dlp necesita un runtime JS para extraer formatos
    YT_OUT_DIR=/downloads

# ffmpeg (merge/audio) + node (runtime JS de yt-dlp)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY server.py youtube-downloader.py ./
COPY web/ ./web/

VOLUME ["/downloads"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8000"]
