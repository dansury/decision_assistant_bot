/**
 * Модальности и каталог моделей под них (ТЗ.md §7.1).
 *
 * Слой конвейера — это «что за стадия», модальность — «что за вход». Второй
 * уровень выбора модели («одна модель на весь голос») живёт здесь, вместе с
 * каталогом кандидатов и примерными ценами: он же питает кнопку «сменить
 * нейросеть» в отчёте о нераспознанном.
 *
 * Конфиг: config/modality_models.json. Fail-soft: битый/отсутствующий файл →
 * пустой каталог, а не исключение.
 */

import fs from "node:fs";
import { repoPath } from "./runtimePaths.js";
import { resolveLayerPolicy } from "./layerPolicy.js";

export const MODALITIES = ["text", "ocr", "vision", "voice", "video"];

export const MODALITY_LABELS = {
  text: "текст",
  ocr: "документы / OCR",
  vision: "изображения",
  voice: "голос",
  video: "видео",
};

/** `requires` слоя из layer_policy.json → модальность. */
const REQUIRES_MODALITY = {
  file: "ocr",
  document: "ocr",
  image: "vision",
  audio: "voice",
  voice: "voice",
  video: "video",
};

const UNITS = ["1k_tokens", "page", "image", "minute"];

const _cache = new Map();

function configPath() {
  return process.env.MODALITY_MODELS_PATH || repoPath("config", "modality_models.json");
}

/**
 * Модальность слоя. Слой 07_handwriting требует image, 05_document_intake —
 * file, и так далее; всё остальное — текст.
 */
export function modalityOfLayer(layer, options = {}) {
  const policy = resolveLayerPolicy(layer, options);
  for (const need of policy.requires || []) {
    const modality = REQUIRES_MODALITY[need];
    if (modality) return modality;
  }
  return "text";
}

export function isModality(value) {
  return MODALITIES.includes(value);
}

function parseModel(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  const price = Number(raw.usd_per_unit);
  return {
    id: raw.id,
    label: typeof raw.label === "string" && raw.label ? raw.label : raw.id,
    tier: raw.tier === "free" ? "free" : "paid",
    unit: UNITS.includes(raw.unit) ? raw.unit : "1k_tokens",
    usdPerUnit: Number.isFinite(price) && price > 0 ? price : 0,
    note: typeof raw.note === "string" ? raw.note : "",
  };
}

export function loadModalityCatalog({ path = configPath(), refresh = false } = {}) {
  if (!refresh && _cache.has(path)) return _cache.get(path);
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    doc = {};
  }
  const catalog = {};
  for (const modality of MODALITIES) {
    const raw = doc?.[modality];
    if (!raw || typeof raw !== "object") continue;
    const models = (Array.isArray(raw.models) ? raw.models : []).map(parseModel).filter(Boolean);
    catalog[modality] = {
      models,
      default: typeof raw.default === "string" && raw.default ? raw.default : null,
    };
  }
  _cache.set(path, catalog);
  return catalog;
}

export function resetModalityCache() {
  _cache.clear();
}

/** Кандидаты под модальность: бесплатные первыми, дальше по возрастанию цены. */
export function candidates(modality, options = {}) {
  const entry = loadModalityCatalog(options)[modality];
  if (!entry) return [];
  return [...entry.models].sort((a, b) => {
    if ((a.tier === "free") !== (b.tier === "free")) return a.tier === "free" ? -1 : 1;
    return a.usdPerUnit - b.usdPerUnit;
  });
}

export function defaultModelForModality(modality, options = {}) {
  return loadModalityCatalog(options)[modality]?.default ?? null;
}

export function findModel(modality, modelId, options = {}) {
  return candidates(modality, options).find((m) => m.id === modelId) ?? null;
}

/**
 * Примерная цена за конкретный объём (страницы / изображения / минуты /
 * 1k токенов). Неизвестная модель → null, а не выдуманный ноль.
 */
export function priceForVolume(modality, modelId, units, options = {}) {
  const model = findModel(modality, modelId, options);
  if (!model) return null;
  const volume = Math.max(0, Number(units) || 0);
  return Math.round(volume * model.usdPerUnit * 1e6) / 1e6;
}

export function unitOf(modality, options = {}) {
  return candidates(modality, options)[0]?.unit ?? "1k_tokens";
}
