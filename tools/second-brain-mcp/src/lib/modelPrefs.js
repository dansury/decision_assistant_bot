/**
 * Три уровня выбора модели, приоритет 3 > 2 > 1 (ТЗ.md §7.1).
 *
 *   3. layers.<слой>        — индивидуальный выбор, сильнее всех
 *   2. modalities.<мод.>    — одна модель на все слои модальности
 *   1. global               — общий запасной вариант
 *   —  политика слоя + каталог модальности
 *
 * Уровни лежат в РАЗНЫХ ключах: запись общего выбора физически не может
 * затереть слой, настроенный вручную. Это и было требованием владельца.
 *
 * Файл состояния — $DATA_DIR/model_prefs.json (том amvera), а не config/:
 * config правит владелец руками, а это выбирается кнопками в чате.
 */

import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./runtimePaths.js";
import { defaultModelForLayer, loadLayerPolicy, resolveLayerPolicy } from "./layerPolicy.js";
import {
  MODALITIES,
  defaultModelForModality,
  findModel,
  isModality,
  modalityOfLayer,
} from "./modality.js";

export const LEVELS = ["global", "modality", "layer"];

const EMPTY = { global: null, modalities: {}, layers: {} };

function prefsPath() {
  return process.env.MODEL_PREFS_PATH || dataPath("model_prefs.json");
}

export function loadPrefs({ path: file = prefsPath() } = {}) {
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...EMPTY, modalities: {}, layers: {} };
  }
  return {
    global: typeof doc.global === "string" && doc.global ? doc.global : null,
    modalities: doc.modalities && typeof doc.modalities === "object" ? { ...doc.modalities } : {},
    layers: doc.layers && typeof doc.layers === "object" ? { ...doc.layers } : {},
  };
}

export function savePrefs(prefs, { path: file = prefsPath() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function str(value) {
  return typeof value === "string" && value ? value : null;
}

/**
 * Кто решил модель для этого слоя и какая она.
 * @returns {{model: string, level: "layer"|"modality"|"global"|"policy", modality: string}}
 */
export function resolveModelForLayer(layer, { prefs = null, freeTop1 = null, ...options } = {}) {
  const stored = prefs ?? loadPrefs(options);
  const policy = resolveLayerPolicy(layer, options);
  const key = policy.layer;
  const modality = modalityOfLayer(layer, options);

  const pinned = str(stored.layers?.[key]) || str(stored.layers?.[layer]);
  if (pinned) return { model: pinned, level: "layer", modality, layer: key };

  const byModality = str(stored.modalities?.[modality]);
  if (byModality) return { model: byModality, level: "modality", modality, layer: key };

  const global = str(stored.global);
  if (global && (modality === "text" || findModel(modality, global, options))) {
    return { model: global, level: "global", modality, layer: key };
  }

  const fromPolicy = defaultModelForLayer(layer, { freeTop1, ...options });

  // freeTop1 приходит уже отфильтрованным по policy.requires (см.
  // recommendModelForLayer), поэтому бесплатная модель на медийном слое —
  // заведомо подходящая, и подменять её каталогом нельзя.
  const policyIsSuitable =
    modality === "text" || (freeTop1 && fromPolicy === freeTop1) || Boolean(findModel(modality, fromPolicy, options));

  if (!policyIsSuitable) {
    // Иначе медийный слой получил бы текстовый платный дефолт, а текстовая
    // модель не расшифрует .ogg. Каталог модальности знает, что расшифрует.
    const fromCatalog = defaultModelForModality(modality, options);
    if (fromCatalog) {
      return {
        model: fromCatalog,
        level: "policy",
        modality,
        layer: key,
        note: global
          ? `общая модель ${global} не поддерживает модальность «${modality}»`
          : `дефолт слоя не поддерживает модальность «${modality}»`,
      };
    }
  }
  return { model: fromPolicy, level: "policy", modality, layer: key };
}

/**
 * Записать выбор на одном уровне. Другие уровни не трогаются — в этом весь
 * смысл: «одна модель на всё» не сбрасывает точечные настройки.
 */
export function setPreference({ level, value = null, model, ...options }) {
  if (!LEVELS.includes(level)) {
    throw new Error(`set_model_preference: level должен быть одним из ${LEVELS.join(", ")}`);
  }
  const modelId = String(model ?? "").trim();
  if (!modelId) throw new Error("set_model_preference: пустой model");

  const prefs = loadPrefs(options);
  if (level === "global") {
    prefs.global = modelId;
  } else if (level === "modality") {
    if (!isModality(value)) {
      throw new Error(
        `set_model_preference: модальность должна быть одной из ${MODALITIES.join(", ")}`,
      );
    }
    prefs.modalities = { ...prefs.modalities, [value]: modelId };
  } else {
    const layerKey = String(value ?? "").trim();
    if (!layerKey) throw new Error("set_model_preference: для level=layer нужен value со слоем");
    const resolved = resolveLayerPolicy(layerKey, options).layer;
    prefs.layers = { ...prefs.layers, [resolved]: modelId };
  }
  const file = savePrefs(prefs, options);
  return { level, value, model: modelId, path: file, prefs };
}

/** Снять выбор на уровне — слой снова падает на модальность, и так далее. */
export function clearPreference({ level, value = null, ...options }) {
  if (!LEVELS.includes(level)) {
    throw new Error(`clear: level должен быть одним из ${LEVELS.join(", ")}`);
  }
  const prefs = loadPrefs(options);
  if (level === "global") prefs.global = null;
  else if (level === "modality") delete prefs.modalities[value];
  else delete prefs.layers[resolveLayerPolicy(String(value ?? ""), options).layer];
  savePrefs(prefs, options);
  return { cleared: { level, value }, prefs };
}

/** Что выбрано и что из этого следует для каждого известного слоя. */
export function explainPreferences({ layer = null, freeTop1 = null, ...options } = {}) {
  const prefs = loadPrefs(options);
  if (layer) {
    return { prefs, resolved: [resolveModelForLayer(layer, { prefs, freeTop1, ...options })] };
  }
  const layers = Object.keys(loadLayerPolicy(options).layers);
  return {
    prefs,
    resolved: layers.map((name) => resolveModelForLayer(name, { prefs, freeTop1, ...options })),
    priority: "layer > modality > global > policy",
  };
}
