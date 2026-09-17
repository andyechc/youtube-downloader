/* YT Downloader — frontend 100% estático (GitHub Pages).
 * Lógica portada del CLI (youtube-downloader.py):
 *  QUALITIES, resolución de calidad por altura y selección de stream.
 * Sin backend: resolvemos vía API pública Piped y descargamos al navegador
 * con fetch -> Blob -> <a download>. Nada se sube a ningún servidor propio.
 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

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

function qualityLabel(q) {
  return q === 'best' ? 'Máxima' : `${q}p`;
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

function isPlaylistUrl(raw) {
  try {
    const u = new URL(raw.trim());
    return u.searchParams.has('list') && (u.pathname === '/playlist' || u.pathname === '/watch');
  } catch {
    return false;
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
  return { stream: mp4 || pool[0] || null, onlyVideoFallback: within.length === 0 && muxed.length === 0 };
}

/** Elige el mejor stream videoOnly como último recurso. */
function pickVideoOnlyFallback(videoStreams, quality) {
  const cap = qualityCap(quality);
  const only = (videoStreams || []).filter((s) => s.videoOnly === true && (s.height || 0) <= cap);
  only.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  return only[0] || null;
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

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtViews(n) {
  if (n == null) return '—';
  return `${Number(n).toLocaleString('es-ES')} vistas`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Estado + elementos                                                  */
/* ------------------------------------------------------------------ */
const form = $('#dl-form');
const urlInput = $('#urlInput');
const urlError = $('#url-error');
const btnClear = $('#btnClear');
const btnPaste = $('#btnPaste');
const btnPreview = $('#btnPreview');
const btnPreviewText = $('#btnPreviewText');
const alertBox = $('#alertBox');
const netFallback = $('#netFallback');
const cliCmd = $('#cliCmd');
const btnCopyCli = $('#btnCopyCli');
const kindHint = $('#kind-hint');
const toastEl = $('#toast');

const previewCard = $('#previewCard');
const pvThumb = $('#pvThumb');
const pvTitle = $('#pvTitle');
const pvChannel = $('#pvChannel');
const pvViews = $('#pvViews');
const pvDate = $('#pvDate');
const pvDuration = $('#pvDuration');
const pvDesc = $('#pvDesc');
const pvSize = $('#pvSize');
const pvTypeBadge = $('#pvTypeBadge');
const pvQualityBadge = $('#pvQualityBadge');
const btnOpenYT = $('#btnOpenYT');
const btnDownload = $('#btnDownload');

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

let current = null; // { videoId, pageUrl, streams, picked, kind, quality, filename }
let aborter = null;

/* Modo servidor local (mejora progresiva): si la web se sirve desde
 * `python server.py` (mismo origen con /api/*), lo usamos para máxima
 * calidad, MP3 320 y playlists. En GitHub Pages no existe y se usa el
 * modo navegador (Piped). */
let localServer = false;
let serverJobId = null;
let pollTimer = null;
const modePill = $('#modePill');

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
        modePill.textContent = 'modo local · máxima calidad';
        modePill.classList.add('local');
        return;
      }
    }
  } catch { /* GitHub Pages: sin servidor, modo navegador */ }
  modePill.textContent = 'modo navegador';
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
  netFallback.hidden = true;
}

function cliCommandFor(pageUrl) {
  const { quality, kind } = currentSelection();
  const parts = ['python youtube-downloader.py', `"${pageUrl}"`];
  if (kind === 'audio') parts.push('-a');
  else if (quality !== 'best') parts.push('-q', quality);
  return parts.join(' ');
}

function showNetFallback(pageUrl) {
  cliCmd.textContent = cliCommandFor(pageUrl);
  netFallback.hidden = false;
}
function setUrlError(msg) {
  if (!msg) { urlError.hidden = true; urlError.textContent = ''; urlInput.removeAttribute('aria-invalid'); return; }
  urlError.textContent = msg;
  urlError.hidden = false;
  urlInput.setAttribute('aria-invalid', 'true');
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
      fps: s.fps || 30,
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
        fps: s.fps || 30,
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
    uploadDate: d.published ? new Date(d.published * 1000).toLocaleDateString('es-ES') : '',
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
/* Preview                                                             */
/* ------------------------------------------------------------------ */
function currentSelection() {
  return { quality: selectedQuality(), kind: selectedKind() };
}

function refreshKindHint() {
  if (localServer) {
    kindHint.textContent = selectedKind() === 'audio'
      ? 'El servidor local convierte a MP3 320kbps con ffmpeg.'
      : 'El servidor local mezcla la máxima calidad disponible.';
  } else {
    kindHint.textContent = selectedKind() === 'audio'
      ? 'Se descarga el audio original en M4A (máxima calidad disponible). ¿Quieres MP3 320? Usa el CLI.'
      : 'Se descarga video MP4 con audio incluido, listo para TV y móvil.';
  }
  pvTypeBadge.textContent = selectedKind() === 'audio' ? 'AUDIO · M4A' : 'VIDEO · MP4';
  pvQualityBadge.textContent = qualityLabel(selectedQuality());
  if (current) repick();
}

function repick() {
  if (!current || !current.streams) return;
  const { quality, kind } = currentSelection();
  const picked = kind === 'audio'
    ? pickAudioStream(current.streams.audioStreams)
    : pickVideoStream(current.streams.videoStreams, quality).stream || pickVideoOnlyFallback(current.streams.videoStreams, quality);
  current.picked = picked;
  current.quality = quality;
  current.kind = kind;
  renderPickedMeta();
}

function renderPickedMeta() {
  const { quality, kind } = currentSelection();
  pvQualityBadge.textContent = qualityLabel(quality);
  pvTypeBadge.textContent = kind === 'audio' ? 'AUDIO · M4A' : 'VIDEO · MP4';
  if (!current?.picked) { pvSize.textContent = '—'; return; }
  const p = current.picked;
  const bits = [];
  if (kind === 'video') {
    bits.push(p.quality || (p.height ? `${p.height}p` : 'MP4'));
    if (p.videoOnly) bits.push('solo video');
  } else {
    bits.push(p.quality || 'audio');
  }
  pvSize.textContent = bits.join(' · ');
}

async function doPreview(event) {
  if (event) event.preventDefault();
  hideAlert();
  setUrlError('');
  const raw = urlInput.value.trim();

  if (!raw) { setUrlError('Pega un enlace de YouTube primero.'); urlInput.focus(); return; }
  if (localServer) return doServerPreview(raw);
  const videoId = extractVideoId(raw);
  if (!videoId) {
    if (isPlaylistUrl(raw)) {
      setUrlError('Ese enlace es una playlist. La web descarga un video cada vez; para playlists completas usa el CLI.');
      showAlert('Las playlists completas solo están en el CLI ( Releases → youtube-downloader ). Aquí pega el enlace del video individual.');
    } else {
      setUrlError('Ese enlace no parece de YouTube. Usa youtube.com/watch, youtu.be/… o /shorts/….');
    }
    urlInput.focus();
    return;
  }

  btnPreview.disabled = true;
  btnPreviewText.textContent = 'Resolviendo…';
  previewCard.hidden = true;
  progressCard.hidden = true;
  progDoneBox.hidden = true;
  current = null;

  try {
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const { data } = await resolveStreams(videoId);

    if (data.livestream) throw new Error('Es un directo. Espera a que termine para descargarlo.');
    if (!data.videoStreams?.length && !data.audioStreams?.length) throw new Error('No se encontraron streams descargables para este video.');

    const { quality, kind } = currentSelection();
    let picked = kind === 'audio'
      ? pickAudioStream(data.audioStreams)
      : pickVideoStream(data.videoStreams, quality).stream || pickVideoOnlyFallback(data.videoStreams, quality);
    if (!picked) throw new Error('No hay streams para esa calidad. Prueba con “Máxima”.');

    const ext = kind === 'audio'
      ? ((picked.mimeType || '').includes('webm') || (picked.codec || '').includes('opus') ? 'webm' : 'm4a')
      : ((picked.mimeType || '').includes('webm') ? 'webm' : 'mp4');
    current = {
      videoId, pageUrl, streams: data, picked, kind, quality,
      filename: `${sanitizeFilename(data.title || videoId)} [${videoId}].${ext}`,
    };

    pvThumb.src = data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    pvThumb.alt = `Miniatura: ${data.title || 'video'}`;
    pvTitle.textContent = data.title || 'Sin título';
    pvChannel.textContent = data.uploader || 'Canal desconocido';
    pvViews.textContent = fmtViews(data.views);
    pvDate.textContent = data.uploadDate || '';
    pvDuration.textContent = fmtDuration(data.duration);
    pvDesc.textContent = (data.description || 'Sin descripción').slice(0, 280);
    btnOpenYT.href = pageUrl;
    renderPickedMeta();
    previewCard.hidden = false;
    previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('Preview listo ✓');
  } catch (e) {
    console.error(e);
    // Fallback: al menos mostrar título vía oEmbed
    try {
      const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const oe = await previewOEmbed(pageUrl);
      if (oe?.title) {
        pvThumb.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        pvTitle.textContent = oe.title;
        pvChannel.textContent = oe.author_name || 'YouTube';
        pvViews.textContent = '—'; pvDate.textContent = '';
        pvDuration.textContent = '—'; pvDesc.textContent = 'No se pudo resolver la calidad ahora mismo. Reintenta en unos segundos.';
        btnOpenYT.href = pageUrl;
        previewCard.hidden = false;
      }
    } catch { /* noop */ }
    if (e?.providerDown) {
      showAlert('Los resolvedores públicos están caídos ahora mismo (les pasa a menudo: son instancias gratuitas). Tu video existe; es la red la que falla. Alternativas de 1 clic abajo.');
      showNetFallback(`https://www.youtube.com/watch?v=${videoId}`);
    } else {
      showAlert(`No se pudo resolver ese video (${e.message || e}). Puede ser privado, con restricción de edad o un fallo temporal. Reintenta o usa el CLI.`);
    }
  } finally {
    btnPreview.disabled = false;
    btnPreviewText.textContent = 'Previsualizar';
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

async function doDownload() {
  if (!current?.picked) { showAlert('Primero previsualiza el video.'); return; }
  hideAlert();
  aborter?.abort();
  aborter = new AbortController();

  const streamUrl = current.picked.url;
  const filename = current.filename;
  progressCard.hidden = false;
  progDoneBox.hidden = true;
  progressLabel.textContent = 'Descargando…';
  progFile.textContent = filename;
  setProgress(0, 0, null, 0, NaN);
  btnDownload.disabled = true;
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
    progEta.textContent = '¡listo!';
    progDoneBox.hidden = false;
    showAlert(`Guardado como “${filename}”. Revisa tu carpeta Descargas.`, true);
    toast('¡Descarga completada! ✓', 3200);
  } catch (e) {
    if (e?.name === 'AbortError' || aborter.signal.aborted) {
      progressLabel.textContent = 'Cancelado';
      progEta.textContent = 'cancelado';
      toast('Descarga cancelada');
      return;
    }
    console.error(e);
    progressLabel.textContent = 'Error';
    showAlert(`Falló la descarga (${e.message || e}). El enlace temporal pudo caducar: vuelve a previsualizar y reintenta. Si persiste, usa el CLI.`);
  } finally {
    btnDownload.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */
form.addEventListener('submit', doPreview);
urlInput.addEventListener('input', () => {
  setUrlError('');
  hideAlert();
  btnClear.hidden = urlInput.value.trim().length === 0;
});
urlInput.addEventListener('blur', () => {
  const v = urlInput.value.trim();
  if (v && !extractVideoId(v) && !isPlaylistUrl(v)) {
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
  current = null;
  urlInput.focus();
});
btnPaste.addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t?.trim()) {
      urlInput.value = t.trim();
      btnClear.hidden = false;
      toast('Pegado ✓');
      doPreview();
    } else toast('El portapapeles está vacío');
  } catch {
    urlInput.focus();
    toast('Pega con Ctrl+V / ⌘V');
  }
});
form.querySelectorAll('input[name="quality"], input[name="kind"]').forEach((r) => {
  r.addEventListener('change', refreshKindHint);
});
btnCopyCli.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cliCmd.textContent);
    toast('Comando copiado ✓');
  } catch {
    toast('Copia el comando manualmente');
  }
});
btnDownload.addEventListener('click', (e) => doDownload(e));
btnCancel.addEventListener('click', () => {
  if (localServer && serverJobId) {
    fetch(`/api/cancel/${serverJobId}`, { method: 'POST' }).catch(() => {});
    clearInterval(pollTimer);
    progressLabel.textContent = 'Cancelado';
    progEta.textContent = 'cancelado';
    toast('Descarga cancelada');
  } else aborter?.abort('cancelled');
});
btnOther.addEventListener('click', () => {
  progressCard.hidden = true;
  previewCard.hidden = true;
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
  doPreview();
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && current && previewCard.hidden === false) {
    e.preventDefault();
    doDownload();
  }
});

/* ------------------------------------------------------------------ */
/* Modo servidor local (server.py) — misma API que la UI anterior      */
/* ------------------------------------------------------------------ */
async function doServerPreview(raw) {
  const { quality, kind } = currentSelection();
  btnPreview.disabled = true;
  btnPreviewText.textContent = 'Resolviendo…';
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
    const info = data.info;

    if (info.type === 'playlist') {
      pvThumb.src = info.thumbnail || '';
      pvTitle.textContent = info.title || 'Playlist';
      pvChannel.textContent = info.uploader || 'Playlist';
      pvViews.textContent = `${info.count} videos`;
      pvDate.textContent = '';
      pvDuration.textContent = `${info.count} vídeos`;
      pvDesc.textContent = (info.description || 'Playlist de YouTube').slice(0, 280);
      pvSize.textContent = info.total_size_str || '—';
    } else {
      pvThumb.src = info.thumbnail || '';
      pvTitle.textContent = info.title || 'Sin título';
      pvChannel.textContent = info.channel || info.uploader || '?';
      pvViews.textContent = info.view_count != null ? fmtViews(info.view_count) : '—';
      pvDate.textContent = info.upload_date || '';
      pvDuration.textContent = info.duration_str || fmtDuration(info.duration);
      pvDesc.textContent = (info.description || 'Sin descripción').slice(0, 280);
      pvSize.textContent = info.size_str || '—';
      btnOpenYT.href = info.webpage_url || raw;
    }
    pvTypeBadge.textContent = kind === 'audio' ? 'AUDIO · MP3 320' : 'VIDEO · MAX';
    pvQualityBadge.textContent = qualityLabel(quality);
    current = { pageUrl: raw, serverInfo: info, kind, quality, filename: null };
    previewCard.hidden = false;
    previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('Preview listo ✓');
  } catch (e) {
    console.error(e);
    showAlert(`No se pudo resolver ese enlace (${e.message || e}).`);
  } finally {
    btnPreview.disabled = false;
    btnPreviewText.textContent = 'Previsualizar';
  }
}

const _doDownloadBrowser = doDownload;
async function doDownload(evt) {
  if (localServer && current?.serverInfo) return doServerDownload();
  return _doDownloadBrowser(evt);
}

async function doServerDownload() {
  hideAlert();
  btnDownload.disabled = true;
  progressCard.hidden = false;
  progDoneBox.hidden = true;
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
      btnDownload.disabled = false;
      if (job.status === 'done') {
        // El servidor guarda en disco Y el navegador descarga el archivo
        setProgress(100, job.total_bytes || job.downloaded_bytes || 0, job.total_bytes || job.downloaded_bytes || null, 0, 0);
        progressLabel.textContent = 'Completado';
        progEta.textContent = '¡listo!';
        const fileUrl = `/api/file/${serverJobId}`;
        btnSaveAgain.href = fileUrl;
        const m = /([^/]+)$/.exec(job.files?.[0] || '');
        btnSaveAgain.download = m ? m[1] : 'descarga';
        const a = document.createElement('a');
        a.href = fileUrl;
        if (m) a.download = m[1];
        document.body.appendChild(a);
        a.click();
        a.remove();
        progDoneBox.hidden = false;
        showAlert('Guardado en tu navegador y en la carpeta del servidor.', true);
        toast('¡Descarga completada! ✓', 3200);
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
    btnDownload.disabled = false;
  }
}

detectLocalServer().finally(() => refreshKindHint());
