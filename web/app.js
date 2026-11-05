/* YT Downloader — frontend local (web + server.py opcional).
 * Un solo paso: pegar link -> Descargar. Sin previews ni pantallas extra.
 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);

/* ------------------------------------------------------------------ */
/* Lógica heredada del CLI                                             */
/* ------------------------------------------------------------------ */
const QUALITIES = ['best', '1080', '720', '480', '360'];
/* Proveedores públicos (sin claves, con CORS). El estado cambia por días:
 * se prueban en orden y se usa el primero que responda. */
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://api.piped.yt',
];
const INVIDIOUS_INSTANCES = [
  'https://invidious.f5.si',
];

function qualityCap(q) {
  if (q === 'best') return Number.MAX_SAFE_INTEGER;
  const n = parseInt(q, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** Extrae el videoId de URLs youtube.com/watch, youtu.be, /shorts, /embed, music.youtube */
function extractVideoId(raw) {
  if (!raw) return null;
  const url = raw.trim();
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    const okHost =
      host === 'youtube.com' || host === 'youtu.be' ||
      host === 'music.youtube.com' || host === 'youtube-nocookie.com';
    if (!okHost) return null;
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    }
    if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/') || u.pathname.startsWith('/live/')) {
      const id = u.pathname.split('/')[2];
      return id || null;
    }
    const v = u.searchParams.get('v');
    if (v) return v;
    return null;
  } catch {
    return null;
  }
}

/** Elige el mejor stream muxed (video+audio) <= cap. Fallback: mejor muxed disponible. */
function pickVideoStream(videoStreams, quality) {
  const cap = qualityCap(quality);
  const muxed = (videoStreams || []).filter((s) => s.videoOnly === false);
  const within = muxed.filter((s) => (s.height || 0) <= cap);
  const pool = within.length ? within : muxed;
  pool.sort((a, b) => {
    const h = (b.height || 0) - (a.height || 0);
    if (h !== 0) return h;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });
  // Preferir MP4/H264 para compatibilidad TV/móvil (como el CLI)
  const mp4 = pool.find((s) => /mp4/i.test(s.mimeType || '') || /avc1/i.test(s.codec || ''));
  return mp4 || pool[0] || null;
}

/** Elige el audio de mayor bitrate (el CLI usa bestaudio; aquí M4A/Opus original). */
function pickAudioStream(audioStreams) {
  const pool = [...(audioStreams || [])];
  pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return pool[0] || null;
}

function sanitizeFilename(name, fallback = 'video') {
  const base = (name || fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return base.replace(/[^\w\d\-_.() \[\]]+/g, '_').replace(/_+/g, '_').replace(/^[_. ]+|[_. ]+$/g, '').slice(0, 120) || fallback;
}

function fmtDuration(secs) {
  if (secs == null) return '0:00';
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const r = s % 60;
  const mm = h ? String(m % 60).padStart(2, '0') : String(m);
  return h ? `${h}:${mm}:${String(r).padStart(2, '0')}` : `${mm}:${String(r).padStart(2, '0')}`;
}

function fmtBytes(n) {  if (n == null || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* Estado + elementos                                                  */
/* ------------------------------------------------------------------ */
const form = $('#dl-form');
const urlInput = $('#urlInput');
const urlError = $('#url-error');
const btnClear = $('#btnClear');
const btnSubmit = $('#btnSubmit');
const btnSubmitText = $('#btnSubmitText');
const alertBox = $('#alertBox');
const toastEl = $('#toast');

const progressCard = $('#progressCard');
const progressLabel = $('#progressLabel');
const barProg = $('#barProg');
const barFill = $('#barFill');
const progPct = $('#progPct');
const progSpeed = $('#progSpeed');
const progDone = $('#progDone');
const progEta = $('#progEta');
const progFile = $('#progFile');
const btnCancel = $('#btnCancel');
const progDoneBox = $('#progDoneBox');
const btnSaveAgain = $('#btnSaveAgain');
const btnOther = $('#btnOther');
const plSaveList = $('#plSaveList');

const progSpin = progressCard.querySelector('.spin');
const SPIN_SVG = progSpin ? progSpin.innerHTML : '';
function startSpinner() {
  if (!progSpin) return;
  progSpin.innerHTML = SPIN_SVG;
  progSpin.style.animation = '';
}
function stopSpinner() {
  if (!progSpin) return;
  progSpin.style.animation = 'none';
  progSpin.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
}

const previewCard = $('#previewCard');
const pvThumb = $('#pvThumb');
const pvTitle = $('#pvTitle');
const pvLine = $('#pvLine');
const pvDuration = $('#pvDuration');
const pvSize = $('#pvSize');
const pvTypeBadge = $('#pvTypeBadge');
const pvQualityBadge = $('#pvQualityBadge');
const btnDownload = $('#btnDownload');

let current = null; // { videoId?, pageUrl, streams?, picked?, kind, quality, filename?, serverInfo? }
let aborter = null;

/* Modo servidor local: si la web se sirve desde `python server.py`
 * (mismo origen con /api/*), se usa para máxima calidad y playlists. */
let localServer = false;
let serverJobId = null;
let pollTimer = null;

async function detectLocalServer() {
  if (!/^https?:$/.test(location.protocol)) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), 1500);
    const res = await fetch('/api/health', { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data && data.ok !== false) {
        localServer = true;
        return;
      }
    }
  } catch { /* sin servidor: modo navegador */ }
}

function selectedQuality() {
  return (form.querySelector('input[name="quality"]:checked') || {}).value || 'best';
}
function selectedKind() {
  return (form.querySelector('input[name="kind"]:checked') || {}).value || 'video';
}

function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function showAlert(msg, ok = false) {
  alertBox.textContent = msg;
  alertBox.classList.toggle('ok', ok);
  alertBox.hidden = false;
}
function hideAlert() {
  alertBox.hidden = true;
  alertBox.textContent = '';
}
function setUrlError(msg) {
  if (!msg) { urlError.hidden = true; urlError.textContent = ''; urlInput.removeAttribute('aria-invalid'); return; }
  urlError.textContent = msg;
  urlError.hidden = false;
  urlInput.setAttribute('aria-invalid', 'true');
}
function setBusy(busy, label) {
  btnSubmit.disabled = busy;
  btnSubmitText.textContent = label;
}

/* ------------------------------------------------------------------ */
/* Resolución (Piped → Invidious, con failover)                          */
/* ------------------------------------------------------------------ */
async function fetchWithTimeout(url, ms = 10000, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), ms);
  const combined = signal
    ? AbortSignal.any ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal
    : ctrl.signal;
  try {
    return await fetch(url, { signal: combined, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

function isNetErr(e) {
  return e instanceof TypeError || /timeout|abort|network|fetch|load failed/i.test(e?.message || e?.name || '');
}

function parseHeight(s) {
  const m = /(\d{3,5})\s*p/i.exec(s?.qualityLabel || s?.quality || '') || /x(\d{3,5})/.exec(s?.resolution || '');
  return m ? parseInt(m[1], 10) : (s?.height || 0);
}

function codecFromType(t) {
  const m = /codecs="([^"]+)"/.exec(t || '');
  return m ? m[1].split(',')[0].trim() : '';
}

/** Normaliza /api/v1/videos de Invidious al mismo shape que Piped. */
function normalizeInvidious(d) {
  const thumbs = [...(d.videoThumbnails || [])].sort((a, b) => (b.width || 0) - (a.width || 0));
  const videoStreams = [];
  for (const s of d.formatStreams || []) {
    videoStreams.push({
      quality: s.qualityLabel || s.quality || 'SD',
      height: parseHeight(s),
      mimeType: (s.type || '').split(';')[0],
      codec: codecFromType(s.type),
      bitrate: 0,
      url: s.url,
      videoOnly: false,
    });
  }
  for (const s of d.adaptiveFormats || []) {
    const t = (s.type || '');
    if (t.startsWith('video')) {
      videoStreams.push({
        quality: s.qualityLabel || 'HD',
        height: parseHeight(s),
        mimeType: t.split(';')[0],
        codec: s.encoding || codecFromType(t),
        bitrate: s.bitrate || 0,
        url: s.url,
        videoOnly: true,
      });
    }
  }
  const audioStreams = (d.adaptiveFormats || [])
    .filter((s) => (s.type || '').startsWith('audio'))
    .map((s) => ({
      quality: s.qualityLabel || (s.bitrate ? `${Math.round(s.bitrate / 1000)} kbps` : 'audio'),
      bitrate: s.bitrate || 0,
      mimeType: (s.type || '').split(';')[0],
      codec: s.encoding || codecFromType(s.type),
      url: s.url,
    }));
  return {
    title: d.title,
    uploader: d.author,
    views: d.viewCount,
    duration: d.lengthSeconds,
    thumbnailUrl: thumbs[0]?.url,
    description: d.description,
    livestream: !!d.liveNow,
    videoStreams,
    audioStreams,
  };
}

async function resolveStreams(videoId) {
  let netFails = 0;
  let lastError = null;
  const attempt = async (url) => {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (isNetErr(e)) netFails += 1;
      lastError = e;
      return null;
    }
  };
  for (const base of PIPED_INSTANCES) {
    const data = await attempt(`${base}/streams/${videoId}`);
    if (data && (data.title || (data.videoStreams || []).length || (data.audioStreams || []).length)) {
      return { data, via: 'piped' };
    }
  }
  for (const base of INVIDIOUS_INSTANCES) {
    const raw = await attempt(`${base}/api/v1/videos/${videoId}`);
    if (raw?.title || raw?.formatStreams?.length || raw?.adaptiveFormats?.length) {
      const data = normalizeInvidious(raw);
      if (data.videoStreams.length || data.audioStreams.length) return { data, via: 'invidious' };
    }
  }
  const err = new Error(lastError?.message || 'Sin instancias disponibles');
  err.providerDown = netFails > 0;
  throw err;
}

async function previewOEmbed(pageUrl) {
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Flujo único: resolver y descargar                                   */
/* ------------------------------------------------------------------ */
function currentSelection() {
  return { quality: selectedQuality(), kind: selectedKind() };
}

function qualityName(q) {
  return q === 'best' ? 'Máxima' : `${q}p`;
}

function renderPreviewCard({ thumb, title, line, size, quality, kind, duration }) {
  if (thumb) pvThumb.src = thumb;
  else pvThumb.removeAttribute('src');
  pvTitle.textContent = title || 'Sin título';
  pvLine.textContent = line || '—';
  pvSize.textContent = size || '—';
  pvQualityBadge.textContent = qualityName(quality);
  pvTypeBadge.textContent = kind === 'audio' ? 'AUDIO' : 'VIDEO';
  pvDuration.textContent = duration || '0:00';
  previewCard.hidden = false;
  previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function startDownload(event) {
  if (event) event.preventDefault();
  hideAlert();
  setUrlError('');
  const raw = urlInput.value.trim();

  if (!raw) { setUrlError('Pega un enlace de YouTube primero.'); urlInput.focus(); return; }
  if (localServer) return doServerFlow(raw);
  const videoId = extractVideoId(raw);
  if (!videoId) {
    setUrlError('Ese enlace no parece un video de YouTube válido.');
    urlInput.focus();
    return;
  }
  return doBrowserFlow(videoId);
}

async function doBrowserFlow(videoId) {
  setBusy(true, 'Resolviendo…');
  previewCard.hidden = true;
  progressCard.hidden = true;
  progDoneBox.hidden = true;
  current = null;

  try {
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const { data } = await resolveStreams(videoId);

    if (data.livestream) throw new Error('Es un directo. Espera a que termine para descargarlo.');
    if (!data.videoStreams?.length && !data.audioStreams?.length) throw new Error('No se encontraron streams descargables.');

    const { quality, kind } = currentSelection();
    const picked = kind === 'audio'
      ? pickAudioStream(data.audioStreams)
      : pickVideoStream(data.videoStreams, quality);
    if (!picked) throw new Error('No hay streams para esa calidad. Prueba con “Máxima”.');

    const ext = kind === 'audio'
      ? ((picked.mimeType || '').includes('webm') || (picked.codec || '').includes('opus') ? 'webm' : 'm4a')
      : ((picked.mimeType || '').includes('webm') ? 'webm' : 'mp4');
    current = {
      videoId, pageUrl, streams: data, picked, kind, quality,
      filename: `${sanitizeFilename(data.title || videoId)} [${videoId}].${ext}`,
    };
    renderPreviewCard({
      thumb: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      title: data.title,
      line: data.uploader || 'YouTube',
      size: picked.quality || (picked.height ? `${picked.height}p` : '—'),
      quality, kind,
      duration: fmtDuration(data.duration),
    });
    toast('Vista previa lista — pulsa Descargar ahora ✓');
  } catch (e) {
    console.error(e);
    let videoExists = false;
    try {
      const oe = await previewOEmbed(`https://www.youtube.com/watch?v=${videoId}`);
      if (oe?.title) videoExists = true;
    } catch { /* noop */ }
    if (e?.providerDown && videoExists) {
      showAlert('Tu video existe, pero no se pudo resolver ahora mismo. Reintenta en unos segundos.');
    } else {
      showAlert(`No se pudo descargar (${e.message || e}).`);
    }
  } finally {
    setBusy(false, 'Descargar');
  }
}

/* ------------------------------------------------------------------ */
/* Descarga al navegador con progreso real                             */
/* ------------------------------------------------------------------ */
function setProgress(pct, downloaded, total, speedBps, etaSec) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  barFill.style.width = `${clamped}%`;
  barProg.setAttribute('aria-valuenow', String(Math.round(clamped)));
  progPct.textContent = `${clamped.toFixed(clamped < 10 ? 1 : 0)}%`;
  progSpeed.textContent = speedBps ? `${fmtBytes(speedBps)}/s` : '—';
  progDone.textContent = total ? `${fmtBytes(downloaded)} / ${fmtBytes(total)}` : fmtBytes(downloaded);
  progEta.textContent = Number.isFinite(etaSec) && etaSec >= 0 ? `quedan ~${Math.ceil(etaSec)}s` : '—';
}

async function doDownloadBrowser() {
  if (!current?.picked) { showAlert('Primero pega un enlace válido.'); return; }
  hideAlert();
  aborter?.abort();
  aborter = new AbortController();
  btnDownload.disabled = true;

  const streamUrl = current.picked.url;
  const filename = current.filename;
  progressCard.hidden = false;
  progDoneBox.hidden = true;
  startSpinner();
  progressLabel.textContent = 'Descargando…';
  progFile.textContent = filename;
  setProgress(0, 0, null, 0, NaN);
  setBusy(true, 'Descargando…');
  progressCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const started = performance.now();
  try {
    const res = await fetch(streamUrl, { signal: aborter.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || null;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const elapsed = (performance.now() - started) / 1000;
      const speed = elapsed > 0 ? received / elapsed : 0;
      const pct = total ? (received / total) * 100 : Math.min(99, (received / (8 * 1024 * 1024)) * 100);
      const eta = total && speed > 0 ? (total - received) / speed : NaN;
      setProgress(pct, received, total, speed, eta);
      progFile.textContent = `${filename} · ${fmtBytes(received)}${total ? ` de ${fmtBytes(total)}` : ''}`;
    }

    const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);
    btnSaveAgain.href = objectUrl;
    btnSaveAgain.download = filename;

    // Descarga automática + botón de reintento (el blob vive en memoria)
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setProgress(100, received, total || received, 0, 0);
    progressLabel.textContent = 'Completado';
    stopSpinner();
    progEta.textContent = '¡listo!';
    progDoneBox.hidden = false;
    plSaveList.hidden = true;
    btnSaveAgain.style.display = '';
    showAlert(`Guardado como “${filename}”. Revisa tu carpeta Descargas.`, true);
    toast('¡Descarga completada! ✓', 3200);
  } catch (e) {
    if (e?.name === 'AbortError' || aborter.signal.aborted) return; // UI ya reseteada por Cancelar
    console.error(e);
    stopSpinner();
    progressLabel.textContent = 'Error';
    showAlert(`Falló la descarga (${e.message || e}). Vuelve a intentarlo.`);
  } finally {
    setBusy(false, 'Descargar');
    btnDownload.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Modo servidor local (server.py)                                     */
/* ------------------------------------------------------------------ */
async function doServerFlow(raw) {
  const { quality, kind } = currentSelection();
  setBusy(true, 'Resolviendo…');
  previewCard.hidden = true;
  progressCard.hidden = true;
  progDoneBox.hidden = true;
  current = null;

  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: raw, quality, audio: kind === 'audio' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Error ${res.status}`);
    current = { pageUrl: raw, serverInfo: data.info, kind, quality, filename: null };
    renderServerPreview(data.info, quality, kind, raw);
    toast('Vista previa lista — pulsa Descargar ahora ✓');
  } catch (e) {
    console.error(e);
    showAlert(`No se pudo descargar (${e.message || e}).`);
  } finally {
    setBusy(false, 'Descargar');
  }
}

function renderServerPreview(info, quality, kind, raw) {
  if (info.type === 'playlist') {
    renderPreviewCard({
      thumb: info.thumbnail || '',
      title: info.title || 'Playlist',
      line: `${info.count} videos`,
      size: info.total_size_str || '—',
      quality, kind,
      duration: `${info.count} vídeos`,
    });
    return;
  }
  renderPreviewCard({
    thumb: info.thumbnail || '',
    title: info.title,
    line: [info.channel || info.uploader, info.upload_date].filter(Boolean).join(' · ') || 'YouTube',
    size: info.size_str,
    quality, kind,
    duration: info.duration_str,
  });
}

async function doServerDownload() {
  hideAlert();
  setBusy(true, 'Descargando…');
  btnDownload.disabled = true;
  progressCard.hidden = false;
  progDoneBox.hidden = true;
  plSaveList.hidden = true;
  plSaveList.innerHTML = '';
  btnSaveAgain.style.display = '';
  startSpinner();
  progressLabel.textContent = 'Descargando…';
  progFile.textContent = current.serverInfo.title || current.pageUrl;
  setProgress(0, 0, null, 0, NaN);
  progressCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: current.pageUrl, quality: current.quality, audio: current.kind === 'audio' }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Error al iniciar descarga');
    serverJobId = data.jobId;
    clearInterval(pollTimer);
    pollTimer = setInterval(pollServerJob, 700);
    toast('Descarga iniciada ↓');
  } catch (e) {
    showAlert(e.message || 'Error iniciando descarga');
    setBusy(false, 'Descargar');
    btnDownload.disabled = false;
  }
}

async function pollServerJob() {
  try {
    const res = await fetch(`/api/progress?jobId=${encodeURIComponent(serverJobId)}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || 'job no encontrado');
    setProgress(
      job.progress || 0,
      job.downloaded_bytes || 0,
      job.total_bytes || null,
      job.speed_raw || 0,
      job.eta_raw ?? NaN,
    );
    progFile.textContent = (job.current_filename || current?.serverInfo?.title || '').split('/').pop();
    if (job.speed) progSpeed.textContent = job.speed;
    if (job.eta) progEta.textContent = job.eta;
    if (job.status === 'processing') progressLabel.textContent = 'Procesando…';

    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      clearInterval(pollTimer);
      setBusy(false, 'Descargar');
      btnDownload.disabled = false;
      stopSpinner();
      if (job.status === 'done') {
        const usable = (job.files || []).filter((f) => f);
        if (!usable.length) {
          progressLabel.textContent = 'Error';
          progEta.textContent = 'sin archivos';
          showAlert('Terminó sin archivos que entregar. Reintenta.');
          return;
        }
        setProgress(100, job.total_bytes || job.downloaded_bytes || 0, job.total_bytes || job.downloaded_bytes || null, 0, 0);
        progressLabel.textContent = 'Completado';
        progEta.textContent = '¡listo!';
        progDoneBox.hidden = false;
        if (current?.serverInfo?.type === 'playlist') {
          // Playlist: un botón Guardar por video (entrega one-shot por índice).
          btnSaveAgain.style.display = 'none';
          const n = renderPlaylistSaveList(serverJobId, job.files);
          showAlert(`Playlist lista: guarda cada video con su botón (${n} disponibles).`, true);
        } else {
          btnSaveAgain.style.display = '';
          plSaveList.hidden = true;
          btnSaveAgain.href = `/api/file/${serverJobId}`;
          const m = /([^/]+)$/.exec(job.files?.[0] || '');
          btnSaveAgain.download = m ? m[1] : 'descarga';
          showAlert('Archivo listo. Pulsa «Guardar archivo» para traerlo a tu navegador.', true);
        }
        toast('¡Listo para guardar! ↓', 3200);
      } else if (job.status === 'error') {
        progressLabel.textContent = 'Error';
        showAlert(job.error || 'Error en la descarga');
      } else {
        progressLabel.textContent = 'Cancelado';
      }
    }
  } catch (e) {
    console.error(e);
    clearInterval(pollTimer);
    setBusy(false, 'Descargar');
  }
}

/* Trae un archivo del job del servidor con errores visibles. */
async function saveServerFile(jobId, idx, filename, btn) {
  const old = btn ? btn.textContent : '';
  if (btn) btn.textContent = 'Trayendo…';
  try {
    const res = await fetch(`/api/file/${encodeURIComponent(jobId)}?idx=${idx}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Error ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'descarga';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast('Archivo guardado ✓');
    return true;
  } catch (err) {
    showAlert(`No se pudo traer el archivo: ${err.message}`);
    return false;
  } finally {
    if (btn) btn.textContent = old;
  }
}

function renderPlaylistSaveList(jobId, files) {
  plSaveList.innerHTML = '';
  const items = (files || []).map((f, i) => ({ f, i })).filter(({ f }) => f);
  items.forEach(({ f, i }) => {
    const name = String(f).split('/').pop();
    const row = document.createElement('div');
    row.className = 'pl-save';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = name;
    t.title = name;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn tiny primary';
    b.textContent = 'Guardar';
    b.addEventListener('click', async () => {
      const ok = await saveServerFile(jobId, i, name, b);
      if (ok) {
        row.classList.add('done');
        b.textContent = 'Guardado ✓';
        b.disabled = true;
      }
    });
    row.append(t, b);
    plSaveList.appendChild(row);
  });
  plSaveList.hidden = items.length === 0;
  return items.length;
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */
form.addEventListener('submit', startDownload);
urlInput.addEventListener('input', () => {
  setUrlError('');
  hideAlert();
  btnClear.hidden = urlInput.value.trim().length === 0;
});
urlInput.addEventListener('blur', () => {
  const v = urlInput.value.trim();
  if (v && !extractVideoId(v)) {
    setUrlError('Revisa el enlace: no parece un video de YouTube válido.');
  }
});
btnClear.addEventListener('click', () => {
  urlInput.value = '';
  btnClear.hidden = true;
  setUrlError('');
  hideAlert();
  previewCard.hidden = true;
  progressCard.hidden = true;
  plSaveList.hidden = true;
  plSaveList.innerHTML = '';
  btnSaveAgain.style.display = '';
  current = null;
  urlInput.focus();
});
btnDownload.addEventListener('click', () => {
  if (!current) return;
  if (localServer && current.serverInfo) doServerDownload();
  else if (current.picked) doDownloadBrowser();
});
btnCancel.addEventListener('click', () => {
  if (progressCard.hidden) return; // nada en curso
  clearInterval(pollTimer);
  if (localServer && serverJobId) {
    fetch(`/api/cancel/${serverJobId}`, { method: 'POST' }).catch(() => {});
  } else {
    aborter?.abort('cancelled');
  }
  // Estado final explícito: sin barra a medias ni loader girando
  stopSpinner();
  setProgress(0, 0, null, 0, NaN);
  progDone.textContent = '—';
  progEta.textContent = 'cancelado';
  progFile.textContent = 'Descarga cancelada por el usuario.';
  progressLabel.textContent = 'Cancelado';
  setBusy(false, 'Descargar');
  btnDownload.disabled = false;
  toast('Descarga cancelada');
});
/* "Guardar archivo" con errores visibles: si el servidor ya entregó y borró
 * (410) o algo falla, se muestra en vez de descargar un JSON misterioso. */
btnSaveAgain.addEventListener('click', async (e) => {
  const href = btnSaveAgain.getAttribute('href') || '';
  if (!href || href === '#' || href.startsWith('blob:')) return; // nativo
  e.preventDefault();
  await saveServerFile(serverJobId, 0, btnSaveAgain.download || 'descarga', btnSaveAgain);
});
btnOther.addEventListener('click', () => {
  previewCard.hidden = true;
  progressCard.hidden = true;
  plSaveList.hidden = true;
  plSaveList.innerHTML = '';
  btnSaveAgain.style.display = '';
  urlInput.value = '';
  btnClear.hidden = true;
  current = null;
  urlInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ?url=… para compartir / enlazar directo
const params = new URLSearchParams(location.search);
if (params.get('url')) {
  urlInput.value = params.get('url');
  btnClear.hidden = false;
  startDownload();
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && current) {
    e.preventDefault();
    startDownload();
  }
});

detectLocalServer();
