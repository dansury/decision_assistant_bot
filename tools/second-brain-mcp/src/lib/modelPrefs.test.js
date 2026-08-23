/** Три уровня выбора модели (ТЗ.md §7.1). */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearPreference,
  explainPreferences,
  loadPrefs,
  resolveModelForLayer,
  setPreference,
} from "./modelPrefs.js";
import { MODALITIES, candidates, defaultModelForModality, modalityOfLayer, resetModalityCache } from "./modality.js";
import { resetPolicyCache } from "./layerPolicy.js";

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-prefs-"));
  process.env.MODEL_PREFS_PATH = path.join(tmp, "model_prefs.json");
  resetPolicyCache();
  resetModalityCache();
});

afterEach(() => {
  delete process.env.MODEL_PREFS_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("модальность слоя", () => {
  test("выводится из requires в layer_policy.json", () => {
    expect(modalityOfLayer("05_document_intake")).toBe("ocr");
    expect(modalityOfLayer("06_photo_people")).toBe("vision");
    expect(modalityOfLayer("07_handwriting")).toBe("vision");
  });

  test("слой без requires — текстовый", () => {
    expect(modalityOfLayer("04c_precedents")).toBe("text");
    expect(modalityOfLayer("совсем неизвестный слой")).toBe("text");
  });

  test("короткий префикс слоя резолвится так же", () => {
    expect(modalityOfLayer("06")).toBe(modalityOfLayer("06_photo_people"));
  });
});

describe("приоритет 3 > 2 > 1", () => {
  test("слой сильнее модальности, модальность сильнее общей", () => {
    setPreference({ level: "global", model: "g/1" });
    setPreference({ level: "modality", value: "vision", model: "v/1" });
    setPreference({ level: "layer", value: "06_photo_people", model: "L/1" });

    expect(resolveModelForLayer("06_photo_people")).toMatchObject({ model: "L/1", level: "layer" });
    expect(resolveModelForLayer("07_handwriting")).toMatchObject({ model: "v/1", level: "modality" });
    expect(resolveModelForLayer("04c_precedents")).toMatchObject({ model: "g/1", level: "global" });
  });

  test("без единого выбора решает политика слоя", () => {
    expect(resolveModelForLayer("04c_precedents").level).toBe("policy");
  });

  test("слой можно задать коротким префиксом, читается по полному имени", () => {
    setPreference({ level: "layer", value: "04c", model: "L/2" });
    expect(loadPrefs().layers["04c_precedents"]).toBe("L/2");
    expect(resolveModelForLayer("04c_precedents").model).toBe("L/2");
  });
});

describe("уровни не затирают друг друга", () => {
  test("запись общей модели не трогает слой и модальность", () => {
    setPreference({ level: "layer", value: "04c", model: "точечная" });
    setPreference({ level: "modality", value: "voice", model: "голосовая" });
    setPreference({ level: "global", model: "общая" });

    const prefs = loadPrefs();
    expect(prefs.layers["04c_precedents"]).toBe("точечная");
    expect(prefs.modalities.voice).toBe("голосовая");
    expect(resolveModelForLayer("04c_precedents").model).toBe("точечная");
  });

  test("запись модальности не трогает слой", () => {
    setPreference({ level: "layer", value: "06", model: "точечная" });
    setPreference({ level: "modality", value: "vision", model: "модальная" });
    expect(resolveModelForLayer("06_photo_people").model).toBe("точечная");
    expect(resolveModelForLayer("07_handwriting").model).toBe("модальная");
  });

  test("снятие уровня возвращает слой на следующий по силе", () => {
    setPreference({ level: "global", model: "общая" });
    setPreference({ level: "layer", value: "04c", model: "точечная" });
    clearPreference({ level: "layer", value: "04c" });
    expect(resolveModelForLayer("04c_precedents")).toMatchObject({ model: "общая", level: "global" });
  });
});

describe("общая модель и модальность", () => {
  test("текстовая общая модель не достаётся голосу", () => {
    setPreference({ level: "global", model: "openai/gpt-4o-mini" });
    const voice = resolveModelForLayer("07_handwriting", { prefs: { global: "openai/gpt-4o-mini", modalities: {}, layers: {} } });
    // gpt-4o-mini умеет vision, поэтому сюда общая как раз доезжает
    expect(voice.level).toBe("global");
  });

  test("общая модель, не умеющая модальность, заменяется дефолтом каталога", () => {
    const prefs = { global: "нет/такой/модели", modalities: {}, layers: {} };
    const resolved = resolveModelForLayer("06_photo_people", { prefs });
    expect(resolved.level).toBe("policy");
    expect(resolved.model).toBe(defaultModelForModality("vision"));
    expect(resolved.note).toContain("не поддерживает");
  });

  test("подходящая бесплатная модель с фильтром по модальности не подменяется", () => {
    const prefs = { global: null, modalities: {}, layers: {} };
    const resolved = resolveModelForLayer("06_photo_people", { prefs, freeTop1: "free/vision-model" });
    expect(resolved.model).toBe("free/vision-model");
  });
});

describe("валидация", () => {
  test("неизвестный уровень отбивается", () => {
    expect(() => setPreference({ level: "чтотоещё", model: "m" })).toThrow();
  });

  test("неизвестная модальность отбивается", () => {
    expect(() => setPreference({ level: "modality", value: "запах", model: "m" })).toThrow();
  });

  test("уровень layer без слоя отбивается", () => {
    expect(() => setPreference({ level: "layer", model: "m" })).toThrow();
  });

  test("пустая модель отбивается", () => {
    expect(() => setPreference({ level: "global", model: "  " })).toThrow();
  });
});

describe("каталог модальностей", () => {
  test("у каждой модальности есть кандидаты и дефолт из своего списка", () => {
    for (const modality of MODALITIES) {
      const list = candidates(modality);
      expect(list.length).toBeGreaterThan(0);
      const fallback = defaultModelForModality(modality);
      expect(list.some((m) => m.id === fallback)).toBe(true);
    }
  });

  test("бесплатные идут первыми, дальше по возрастанию цены", () => {
    for (const modality of MODALITIES) {
      const list = candidates(modality);
      const keys = list.map((m) => [m.tier === "free" ? 0 : 1, m.usdPerUnit]);
      const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      expect(keys).toEqual(sorted);
    }
  });
});

describe("explainPreferences", () => {
  test("отдаёт решение по каждому известному слою", () => {
    setPreference({ level: "global", model: "общая" });
    const { resolved, priority } = explainPreferences();
    expect(resolved.length).toBeGreaterThan(10);
    expect(priority).toBe("layer > modality > global > policy");
    expect(resolved.every((r) => r.model && r.level)).toBe(true);
  });

  test("с указанным слоем — только он", () => {
    expect(explainPreferences({ layer: "04c" }).resolved).toHaveLength(1);
  });

  test("отсутствующий файл настроек — не ошибка, а пустые настройки", () => {
    expect(loadPrefs()).toEqual({ global: null, modalities: {}, layers: {} });
  });
});
