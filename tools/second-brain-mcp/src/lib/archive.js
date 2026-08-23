/**
 * ZIP-архивы: инспекция, смета, этапы, отчёт (ТЗ.md §8.4).
 *
 * Архив никогда не поднимается в память целиком. Оглавление читается по
 * central directory самого zip (чистый JS, поэтому тестируется без бинарей),
 * а один файл достаётся `unzip -p` — unzip уже стоит в образе.
 *
 * Модуль ничего не распознаёт сам: распознавание — это модель, а модель у
 * hermes. Здесь живут оглавление, порядок, батчи, состояние и отчёт.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dataPath } from "./runtimePaths.js";
import { candidates, priceForVolume, MODALITY_LABELS } from "./modality.js";

// --- виды файлов -------------------------------------------------------------

const EXT_KIND = {
  ".md": "markdown", ".markdown": "markdown",
  ".txt": "text", ".log": "text", ".csv": "text", ".srt": "text", ".vtt": "text",
  ".html": "text", ".htm": "text", ".rtf": "text",
  ".pdf": "document", ".doc": "document", ".docx": "document",
  ".odt": "document", ".epub": "document", ".pptx": "document", ".xlsx": "document",
  ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image",
  ".webp": "image", ".bmp": "image", ".tiff": "image", ".tif": "image", ".heic": "image",
  ".ogg": "audio", ".oga": "audio", ".opus": "audio", ".mp3": "audio",
  ".m4a": "audio", ".wav": "audio", ".flac": "audio", ".aac": "audio",
  ".mp4": "video", ".mov": "video", ".mkv": "video", ".webm": "video", ".avi": "video",
  ".json": "data", ".xml": "data", ".yaml": "data", ".yml": "data",
};

/** Файлы, которые ЕСТЬ переписка, а не метаданные о ней. */
const CONTENT_DATA = new Set(["result.json", "conversations.json"]);

const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const JUNK_DIRS = ["__macosx/", ".git/", ".obsidian/", ".trash/", "node_modules/"];
const NESTED = [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz"];

const CONTENT_KINDS = ["markdown", "text", "document", "image", "audio", "video"];

/** Порядок этапов: сначала дешёвое и надёжное, потом дорогое и капризное. */
export const STAGE_ORDER = ["markdown", "text", "document", "image", "audio", "video"];

export const STAGE_MODALITY = {
  markdown: "text", text: "text", document: "ocr",
  image: "vision", audio: "voice", video: "video",
};

export const STAGE_LAYER = {
  markdown: "08_obsidian_lint", text: "01_transcription_cleanup",
  document: "05_document_intake", image: "06_photo_people",
  audio: "01_transcription_cleanup", video: "01_transcription_cleanup",
};

export const STAGE_LABELS = {
  markdown: "заметки (md)", text: "текст и переписка", document: "документы",
  image: "изображения", audio: "голосовые", video: "видео",
};

export const DEFAULT_LIMITS = {
  maxZipBytes: 200 * 1024 * 1024,
  maxUncompressed: 2 * 1024 * 1024 * 1024,
  maxFiles: 20000,
  maxRatio: 200,
  sampleMd: 40,
  batchSize: 25,
  maxMemberBytes: 40 * 1024 * 1024,
};

const MD_SHARE = 0.6;
const WIKILINK_RE = /\[\[([^\]\[|\n]{1,200})(?:\|[^\]\n]{0,200})?\]\]/g;

export function classify(name) {
  const low = String(name).toLowerCase();
  const base = path.posix.basename(low);
  if (CONTENT_DATA.has(base)) return "text";
  return EXT_KIND[path.posix.extname(low)] ?? "other";
}

function isJunk(name) {
  const low = name.toLowerCase();
  if (low.endsWith("/")) return true;
  const base = path.posix.basename(low);
  if (JUNK_NAMES.has(base) || base.startsWith("._")) return true;
  return JUNK_DIRS.some((dir) => low.includes(dir));
}

// --- чтение central directory ------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/**
 * Записи zip без распаковки: имя, распакованный и упакованный размер.
 * Умышленно свой разбор, а не библиотека: одна функция на ~50 строк, зато
 * тестируется в bun test без бинарей и без сети.
 */
export function readCentralDirectory(buf) {
  const max = Math.min(buf.length, 66000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - max && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("не похоже на zip: не найден End of Central Directory");

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) break;
    const compSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({ name, size, compSize });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function detectFlavour(names, byKind, wikilinks) {
  const content = CONTENT_KINDS.reduce((acc, k) => acc + (byKind[k]?.count ?? 0), 0);
  const md = byKind.markdown?.count ?? 0;
  if (content && md / content >= MD_SHARE && wikilinks > 0) return "obsidian_vault";

  const low = names.map((n) => n.toLowerCase());
  const roots = new Set(low.map((n) => n.split("/")[0]));
  const base = (n) => path.posix.basename(n);
  if (low.some((n) => base(n) === "result.json")) return "telegram_export";
  if (low.some((n) => base(n).startsWith("messages") && n.endsWith(".html"))) return "telegram_export";
  if (["photos", "voice_messages", "video_files", "round_video_messages"].some((d) => roots.has(d))) {
    return "telegram_export";
  }
  if (low.some((n) => base(n) === "conversations.json")) return "chat_export";
  if (low.some((n) => n.endsWith("_chat.txt") || base(n) === "chat.txt")) return "chat_export";
  return "generic";
}

function countWikilinks(file, entries, limit) {
  let found = 0;
  const sample = [...entries].sort((a, b) => b.size - a.size).slice(0, limit);
  for (const entry of sample) {
    const text = readMember(file, entry.name, { maxBytes: 64 * 1024, encoding: "utf8" });
    if (!text) continue;
    found += (text.match(WIKILINK_RE) || []).length;
  }
  return found;
}

// --- извлечение одного файла --------------------------------------------------

/** Один файл архива наружу. `unzip -p` пишет в stdout, распаковки на диск нет. */
export function readMember(file, entry, { maxBytes = 8 * 1024 * 1024, encoding = null } = {}) {
  const res = spawnSync("unzip", ["-p", file, entry], {
    maxBuffer: maxBytes,
    encoding: null,
  });
  if (res.error || res.status !== 0 || !res.stdout?.length) return null;
  const buf = res.stdout.subarray(0, maxBytes);
  return encoding ? buf.toString(encoding) : buf;
}

// --- инспекция ----------------------------------------------------------------

export function inspectArchive({ file, limits = DEFAULT_LIMITS } = {}) {
  const stat = fs.statSync(file);
  if (stat.size > limits.maxZipBytes) {
    throw new Error(
      `архив ${(stat.size / 1048576).toFixed(0)} МБ больше лимита ${limits.maxZipBytes / 1048576} МБ`,
    );
  }
  const buf = fs.readFileSync(file);
  const raw = readCentralDirectory(buf);

  const unpacked = raw.reduce((a, e) => a + e.size, 0);
  const packed = raw.reduce((a, e) => a + e.compSize, 0);
  if (raw.length > limits.maxFiles) throw new Error(`в архиве ${raw.length} файлов, лимит ${limits.maxFiles}`);
  if (unpacked > limits.maxUncompressed) throw new Error("распакованный объём больше лимита");
  if (packed > 0 && unpacked / packed > limits.maxRatio) {
    throw new Error("похоже на zip-бомбу: слишком высокая степень сжатия");
  }

  const entries = [];
  const skipped = [];
  const notes = [];
  let nested = 0;
  let oversized = 0;

  for (const item of raw) {
    if (isJunk(item.name)) continue;
    if (NESTED.some((ext) => item.name.toLowerCase().endsWith(ext))) {
      nested += 1;
      skipped.push(item.name);
      continue;
    }
    if (item.size > limits.maxMemberBytes) {
      oversized += 1;
      skipped.push(item.name);
      continue;
    }
    entries.push({ ...item, kind: classify(item.name) });
  }

  const byKind = {};
  for (const entry of entries) {
    const prev = byKind[entry.kind] ?? { count: 0, bytes: 0 };
    byKind[entry.kind] = { count: prev.count + 1, bytes: prev.bytes + entry.size };
  }

  const md = entries.filter((e) => e.kind === "markdown");
  const wikilinks = md.length ? countWikilinks(file, md, limits.sampleMd) : 0;
  const flavour = detectFlavour(entries.map((e) => e.name), byKind, wikilinks);

  if (nested) notes.push(`вложенных архивов пропущено: ${nested} — распакуй их отдельно`);
  if (oversized) notes.push(`файлов крупнее ${limits.maxMemberBytes / 1048576} МБ пропущено: ${oversized}`);
  if (byKind.other?.count) notes.push(`файлов неизвестного типа: ${byKind.other.count}`);
  if (flavour === "obsidian_vault") {
    notes.push(`Obsidian-vault (${wikilinks} вики-ссылок в выборке) — распознавать нечего, сразу lint`);
  }

  return {
    file,
    flavour,
    entries,
    byKind,
    totalFiles: entries.length,
    totalBytes: entries.reduce((a, e) => a + e.size, 0),
    wikilinks,
    skipped,
    notes,
    fastPath: flavour === "obsidian_vault",
  };
}

// --- смета --------------------------------------------------------------------

export const UNIT_RATES = {
  markdown: { unit: "1k_tokens", bytesPerUnit: 4000, tokensPerUnit: 1000, secPerFile: 0.3, secPerUnit: 1.2 },
  text: { unit: "1k_tokens", bytesPerUnit: 4000, tokensPerUnit: 1000, secPerFile: 0.3, secPerUnit: 1.2 },
  document: { unit: "page", bytesPerUnit: 45000, tokensPerUnit: 600, secPerFile: 1, secPerUnit: 3 },
  image: { unit: "image", bytesPerUnit: 0, tokensPerUnit: 1100, secPerFile: 3.5, secPerUnit: 0 },
  audio: { unit: "minute", bytesPerUnit: 16000 * 60, tokensPerUnit: 900, secPerFile: 1, secPerUnit: 5 },
  video: { unit: "minute", bytesPerUnit: 1200000 * 60, tokensPerUnit: 1200, secPerFile: 2, secPerUnit: 10 },
};

export function unitsFor(kind, files, bytes) {
  const rate = UNIT_RATES[kind];
  if (!rate || files <= 0) return 0;
  if (rate.bytesPerUnit <= 0) return files;
  return Math.max(files, bytes / rate.bytesPerUnit);
}

/**
 * Смета до запуска: этапы, объём, токены, время, ≈цена.
 * @param models {(stage) => string} — какая модель встанет на этап
 */
export function estimateWork(inv, resolveModel, { limits = DEFAULT_LIMITS } = {}) {
  const stages = [];
  const unpriced = [];
  for (const kind of STAGE_ORDER) {
    const files = inv.byKind[kind]?.count ?? 0;
    if (!files) continue;
    const rate = UNIT_RATES[kind];
    const modality = STAGE_MODALITY[kind];
    const model = resolveModel ? resolveModel(kind) : null;
    const units = unitsFor(kind, files, inv.byKind[kind].bytes);

    if (inv.fastPath && kind === "markdown") {
      stages.push({
        stage: kind, modality, model, files, units: round2(units), unit: rate.unit,
        tokens: 0, seconds: round1(files * 0.05), usd: 0, priced: true,
        note: "вики-база пишется как есть, без распознавания",
      });
      continue;
    }
    const price = model ? priceForVolume(modality, model, units) : null;
    if (price === null) unpriced.push(`${STAGE_LABELS[kind]}: ${model ?? "модель не выбрана"}`);
    stages.push({
      stage: kind, modality, model, files, units: round2(units), unit: rate.unit,
      tokens: Math.round(units * rate.tokensPerUnit),
      seconds: round1(files * rate.secPerFile + units * rate.secPerUnit),
      usd: price === null ? 0 : Math.round(price * 1e4) / 1e4,
      priced: price !== null,
    });
  }
  const batches = stages.reduce((a, s) => a + Math.ceil(s.files / limits.batchSize), 0);
  return {
    stages,
    files: stages.reduce((a, s) => a + s.files, 0),
    tokens: stages.reduce((a, s) => a + s.tokens, 0),
    seconds: round1(stages.reduce((a, s) => a + s.seconds, 0)),
    usd: Math.round(stages.reduce((a, s) => a + s.usd, 0) * 1e4) / 1e4,
    batches,
    fastPath: Boolean(inv.fastPath),
    unpriced,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

export function humanDuration(seconds) {
  const s = Math.max(0, seconds);
  if (s < 90) return `~${Math.round(s)} с`;
  const m = s / 60;
  if (m < 90) return `~${Math.round(m)} мин`;
  return `~${(m / 60).toFixed(1)} ч`;
}

// --- состояние разбора ---------------------------------------------------------

/**
 * Что уже обработано. Живёт на томе, поэтому рестарт контейнера посреди
 * гигабайтного архива не отправляет владельца загружать всё заново.
 */
function statePath() {
  return process.env.ARCHIVE_STATE_PATH || dataPath("archive_state.json");
}

export function loadState({ path: file = statePath() } = {}) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return doc && typeof doc === "object" ? doc : {};
  } catch {
    return {};
  }
}

function saveState(state, { path: file = statePath() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

const STATUSES = ["done", "failed", "skipped"];

function archiveKey(file) {
  return path.basename(file);
}

export function markEntry({ file, entry, status, note = "", ...options }) {
  if (!STATUSES.includes(status)) {
    throw new Error(`archive_mark: status должен быть одним из ${STATUSES.join(", ")}`);
  }
  const state = loadState(options);
  const key = archiveKey(file);
  const bucket = state[key] ?? { done: {}, failed: {}, skipped: {} };
  for (const s of STATUSES) delete bucket[s]?.[entry];
  bucket[status] = { ...(bucket[status] ?? {}), [entry]: { note, at: new Date().toISOString() } };
  state[key] = bucket;
  saveState(state, options);
  return { file: key, entry, status, note };
}

export function entryStatus(state, file, entry) {
  const bucket = state[archiveKey(file)];
  if (!bucket) return null;
  for (const s of STATUSES) if (bucket[s]?.[entry]) return s;
  return null;
}

/** Следующий батч этапа — уже обработанное пропускается автоматически. */
export function stageFiles({ inv, stage, offset = 0, limit = DEFAULT_LIMITS.batchSize, ...options }) {
  const state = loadState(options);
  const pending = inv.entries
    .filter((e) => e.kind === stage)
    .filter((e) => entryStatus(state, inv.file, e.name) === null);
  return {
    stage,
    modality: STAGE_MODALITY[stage],
    layer: STAGE_LAYER[stage],
    remaining: pending.length,
    files: pending.slice(offset, offset + limit),
  };
}

// --- отчёт ---------------------------------------------------------------------

export function renderBar(done, total, width = 16) {
  if (total <= 0) return `${"▱".repeat(width)}   0%`;
  const ratio = Math.min(1, Math.max(0, done / total));
  let filled = Math.floor(ratio * width);
  if (done > 0 && filled === 0) filled = 1;
  if (filled === width && done < total) filled = width - 1;
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)} ${String(Math.round(ratio * 100)).padStart(3)}%`;
}

/**
 * Варианты для нераспознанного файла: список подходящих под модальность
 * моделей с ценой под объём ИМЕННО этого файла.
 */
export function modelOptions(kind, units) {
  const modality = STAGE_MODALITY[kind] ?? "text";
  return {
    modality,
    modalityLabel: MODALITY_LABELS[modality] ?? modality,
    options: candidates(modality).slice(0, 4).map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      note: m.note,
      unit: m.unit,
      usd: priceForVolume(modality, m.id, units),
    })),
    actions: ["change_model", "describe_manually", "skip"],
    skipMeaning: "файл в vault не пишется вовсе, поэтому «пропустить» = его в базе нет",
  };
}

export function archiveReport({ inv, ...options }) {
  const state = loadState(options);
  const bucket = state[archiveKey(inv.file)] ?? { done: {}, failed: {}, skipped: {} };
  const stages = [];
  for (const kind of STAGE_ORDER) {
    const entries = inv.entries.filter((e) => e.kind === kind);
    if (!entries.length) continue;
    const done = entries.filter((e) => bucket.done?.[e.name]).length;
    const failed = entries.filter((e) => bucket.failed?.[e.name]).length;
    const skipped = entries.filter((e) => bucket.skipped?.[e.name]).length;
    stages.push({
      stage: kind, label: STAGE_LABELS[kind], total: entries.length, done, failed, skipped,
      finished: done + failed + skipped >= entries.length,
    });
  }
  const total = stages.reduce((a, s) => a + s.total, 0);
  const settled = stages.reduce((a, s) => a + s.done + s.failed + s.skipped, 0);

  const unresolved = inv.entries
    .filter((e) => bucket.failed?.[e.name])
    .map((e) => ({
      name: e.name,
      kind: e.kind,
      reason: bucket.failed[e.name].note || "не распозналось",
      units: round2(unitsFor(e.kind, 1, e.size)),
      ...modelOptions(e.kind, unitsFor(e.kind, 1, e.size)),
    }));

  return {
    file: inv.file,
    flavour: inv.flavour,
    progressBar: renderBar(settled, total),
    stages,
    total,
    settled,
    done: stages.reduce((a, s) => a + s.done, 0),
    failed: stages.reduce((a, s) => a + s.failed, 0),
    skipped: stages.reduce((a, s) => a + s.skipped, 0),
    unresolved,
    finished: settled >= total,
  };
}
