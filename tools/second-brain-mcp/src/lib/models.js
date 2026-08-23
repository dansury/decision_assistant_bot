/**
 * Выбор модели: прайс-лист, топ бесплатных, рекомендация под слой.
 * Источник каталога — openrouter.js, бесплатных — freeCatalog.js.
 * См. Promts/09_feedback_and_model_switch.md и spec-раздел README «Выбор модели».
 */

import { fetchCatalog } from "./openrouter.js";
import { loadFreeModels, filterByModalities, freeTop1 } from "./freeCatalog.js";
import { resolveLayerPolicy, defaultModelForLayer } from "./layerPolicy.js";
import { resolveModelForLayer } from "./modelPrefs.js";

const YANDEX_NOTE =
  "Прайс-каталог доступен только для provider=openrouter. Для остальных провайдеров " +
  "(например yandex) актуальные цены смотрите в консоли провайдера — публичного API цен нет.";

/**
 * Список моделей провайдера по возрастанию цены за промпт-токен —
 * для 👎-флоу слоя 9. Бесплатные помечены isFree и идут первыми.
 */
export async function listModelsByPrice({
  provider = "openrouter",
  limit = 15,
  freeOnly = false,
  fetchImpl = fetch,
} = {}) {
  if (provider !== "openrouter") {
    return { provider, note: YANDEX_NOTE, models: [] };
  }

  const { models: all, error, stale } = await fetchCatalog({ fetchImpl });
  if (error && !all.length) return { provider, error, models: [] };

  const priced = all
    .filter((m) => m.promptPricePerMTok !== null)
    .filter((m) => !freeOnly || m.isFree)
    .sort((a, b) => {
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return a.promptPricePerMTok - b.promptPricePerMTok;
    });

  return {
    provider,
    models: priced.slice(0, limit).map((m) => ({
      id: m.id,
      name: m.name,
      isFree: m.isFree,
      promptPricePerMTok: m.promptPricePerMTok,
      completionPricePerMTok: m.completionPricePerMTok,
      contextTokens: m.contextTokens,
    })),
    totalAvailable: priced.length,
    ...(stale ? { stale: true, error } : {}),
  };
}

/**
 * Топ бесплатных моделей OpenRouter (нулевая цена), отранжированных
 * рейтингом shir-man и суточной квотой. Основной инструмент «переключи меня
 * на бесплатную» из слоя 9 и источник cheap-тира smart_model_routing.
 */
export async function listFreeModels({ limit = 10, modalities = [], fetchImpl = fetch } = {}) {
  try {
    const models = filterByModalities(await loadFreeModels({ fetchImpl }), modalities);
    return {
      provider: "openrouter",
      models: models.slice(0, limit),
      totalAvailable: models.length,
      note:
        "Бесплатные модели OpenRouter: цена $0, но есть суточные лимиты (dailyQuota) " +
        "и меняющийся состав — список обновляется раз в 24 ч.",
    };
  } catch (err) {
    return { provider: "openrouter", error: err.message, models: [] };
  }
}

/**
 * Рекомендация модели под слой конвейера: некритичные слои уходят на топ-1
 * бесплатную (с учётом нужных модальностей), критичные остаются на платной.
 */
export async function recommendModelForLayer({ layer, fetchImpl = fetch } = {}) {
  const policy = resolveLayerPolicy(layer);
  const free = policy.criticality === "non_critical"
    ? await freeTop1({ fetchImpl, modalities: policy.requires })
    : null;
  // Выбор владельца сильнее политики: три уровня (ТЗ.md §7.1) резолвятся
  // первыми, и только если ни один не задан — решает критичность слоя.
  const chosen = resolveModelForLayer(layer, { freeTop1: free });
  const policyModel = defaultModelForLayer(layer, { freeTop1: free });

  const reasonByLevel = {
    layer: "модель выбрана владельцем для этого слоя (уровень 3 — сильнее всех)",
    modality: `модель выбрана владельцем для всей модальности «${chosen.modality}» (уровень 2)`,
    global: "общая модель, выбранная владельцем (уровень 1)",
  };
  const policyReason =
    policy.criticality === "critical"
      ? "критичный слой — качество важнее цены, остаёмся на платной модели"
      : free
        ? "некритичный слой — берём топ-1 из бесплатного каталога OpenRouter"
        : "некритичный слой, но бесплатный каталог недоступен — платный дефолт";

  return {
    layer: policy.layer,
    known: policy.known,
    criticality: policy.criticality,
    expectedOutTokens: policy.expectedOutTokens,
    requires: policy.requires,
    modality: chosen.modality,
    model: chosen.model,
    level: chosen.level,
    policyModel,
    tier: free && chosen.model === free ? "free" : "paid",
    reason: reasonByLevel[chosen.level] ?? policyReason,
    ...(chosen.note ? { note: chosen.note } : {}),
  };
}
