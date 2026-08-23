/** ZIP-архивы: инспекция, смета, состояние, отчёт (ТЗ.md §8.4). */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_LIMITS,
  STAGE_MODALITY,
  STAGE_ORDER,
  archiveReport,
  classify,
  estimateWork,
  humanDuration,
  inspectArchive,
  markEntry,
  modelOptions,
  readCentralDirectory,
  readMember,
  renderBar,
  stageFiles,
  unitsFor,
} from "./archive.js";
import { resetModalityCache } from "./modality.js";

let tmp;
const HAS_ZIP = spawnSync("zip", ["-v"]).status === 0;

function makeZip(files) {
  const dir = fs.mkdtempSync(path.join(tmp, "src-"));
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  const zipPath = path.join(tmp, `${Math.random().toString(36).slice(2)}.zip`);
  const res = spawnSync("zip", ["-q", "-r", "-X", zipPath, "."], { cwd: dir });
  if (res.status !== 0) throw new Error("zip не собрался");
  return zipPath;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-arch-"));
  process.env.ARCHIVE_STATE_PATH = path.join(tmp, "archive_state.json");
  resetModalityCache();
});

afterEach(() => {
  delete process.env.ARCHIVE_STATE_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- чистые функции: работают всегда ---------------------------------------

describe("классификация", () => {
  test("markdown отделён от простого текста", () => {
    expect(classify("notes/a.md")).toBe("markdown");
    expect(classify("notes/a.txt")).toBe("text");
  });

  test("медиа по расширению, регистр не важен", () => {
    expect(classify("P.JPG")).toBe("image");
    expect(classify("v/voice_1.ogg")).toBe("audio");
    expect(classify("clip.MP4")).toBe("video");
    expect(classify("d/report.pdf")).toBe("document");
  });

  test("экспорт переписки — это текст, а не метаданные", () => {
    expect(classify("result.json")).toBe("text");
    expect(classify("ChatGPT/conversations.json")).toBe("text");
    expect(classify("meta/settings.json")).toBe("data");
  });

  test("неизвестное расширение — other", () => {
    expect(classify("weird.qqq")).toBe("other");
    expect(classify("noextension")).toBe("other");
  });
});

describe("единицы объёма", () => {
  test("файлов не меньше, чем единиц: страница минимум одна", () => {
    expect(unitsFor("document", 3, 10)).toBe(3);
  });

  test("текст считается блоками по 1k токенов", () => {
    expect(unitsFor("text", 1, 4000)).toBeCloseTo(1);
    expect(unitsFor("text", 1, 40000)).toBeCloseTo(10);
  });

  test("изображения считаются штуками, а не байтами", () => {
    expect(unitsFor("image", 7, 999999999)).toBe(7);
  });

  test("ноль файлов — ноль единиц", () => {
    expect(unitsFor("video", 0, 10000)).toBe(0);
  });
});

describe("прогресс-бар", () => {
  test("пустой в начале и полный в конце", () => {
    expect(renderBar(0, 10)).toContain("▱");
    expect(renderBar(10, 10)).toContain("100%");
  });

  test("любой сдвиг рисует хотя бы один блок", () => {
    expect((renderBar(1, 1000).match(/▰/g) || []).length).toBe(1);
  });

  test("до конца бар не бывает полным", () => {
    expect((renderBar(999, 1000).match(/▱/g) || []).length).toBe(1);
  });

  test("ноль задач — не деление на ноль", () => {
    expect(renderBar(0, 0)).toContain("0%");
  });
});

describe("человекочитаемая длительность", () => {
  test("секунды, минуты, часы", () => {
    expect(humanDuration(5)).toContain("с");
    expect(humanDuration(300)).toContain("мин");
    expect(humanDuration(10000)).toContain("ч");
  });
});

describe("варианты для нераспознанного файла", () => {
  test("модели подобраны под модальность файла", () => {
    const opts = modelOptions("audio", 4.2);
    expect(opts.modality).toBe("voice");
    expect(opts.options.length).toBeGreaterThan(0);
    expect(opts.actions).toEqual(["change_model", "describe_manually", "skip"]);
  });

  test("цена считается под объём именно этого файла", () => {
    const small = modelOptions("audio", 1).options.map((o) => o.usd);
    const big = modelOptions("audio", 100).options.map((o) => o.usd);
    expect(big).not.toEqual(small);
  });

  test("пропуск честно объяснён: файла в базе и не было", () => {
    expect(modelOptions("image", 1).skipMeaning).toContain("не пишется");
  });
});

describe("таблицы этапов", () => {
  test("каждый этап знает модальность", () => {
    for (const stage of STAGE_ORDER) expect(STAGE_MODALITY[stage]).toBeTruthy();
  });

  test("порядок — от дешёвого к дорогому", () => {
    expect(STAGE_ORDER).toEqual(["markdown", "text", "document", "image", "audio", "video"]);
  });
});

// --- работа с настоящим zip -------------------------------------------------

describe.if(HAS_ZIP)("инспекция архива", () => {
  test("считает файлы и байты по видам", () => {
    const zip = makeZip({ "a.txt": "x".repeat(100), "c.jpg": "\xff".repeat(300) });
    const inv = inspectArchive({ file: zip });
    expect(inv.totalFiles).toBe(2);
    expect(inv.byKind.text.count).toBe(1);
    expect(inv.byKind.image.count).toBe(1);
  });

  test("central directory читается без распаковки", () => {
    const zip = makeZip({ "a.txt": "hello" });
    const entries = readCentralDirectory(fs.readFileSync(zip));
    expect(entries.some((e) => e.name.endsWith("a.txt"))).toBe(true);
  });

  test("мусор и служебные каталоги выбрасываются", () => {
    const zip = makeZip({
      "__MACOSX/._a.txt": "junk",
      ".obsidian/workspace.json": "{}",
      "notes/real.txt": "content",
    });
    const inv = inspectArchive({ file: zip });
    expect(inv.entries.map((e) => e.name)).toEqual(["notes/real.txt"]);
  });

  test("вложенный архив пропускается с пояснением", () => {
    const zip = makeZip({ "inner.zip": "PK\x03\x04", "a.txt": "x" });
    const inv = inspectArchive({ file: zip });
    expect(inv.skipped).toContain("inner.zip");
    expect(inv.notes.join(" ")).toContain("вложенных архивов");
  });

  test("Obsidian-vault узнаётся по доле md и вики-ссылкам", () => {
    const zip = makeZip({ "a.md": "смотри [[b]]", "b.md": "обратно [[a]]" });
    const inv = inspectArchive({ file: zip });
    expect(inv.flavour).toBe("obsidian_vault");
    expect(inv.fastPath).toBe(true);
    expect(inv.wikilinks).toBe(2);
  });

  test("md без перелинковки — ещё не vault", () => {
    const zip = makeZip({ "a.md": "# просто", "b.md": "# тоже просто" });
    expect(inspectArchive({ file: zip }).flavour).toBe("generic");
  });

  test("экспорт Telegram узнаётся по result.json", () => {
    expect(inspectArchive({ file: makeZip({ "result.json": "{}" }) }).flavour).toBe("telegram_export");
  });

  test("экспорт Telegram узнаётся по каталогам медиа", () => {
    const zip = makeZip({ "photos/p.jpg": "x", "voice_messages/v.ogg": "y" });
    expect(inspectArchive({ file: zip }).flavour).toBe("telegram_export");
  });

  test("экспорт нейросети узнаётся по conversations.json", () => {
    expect(inspectArchive({ file: makeZip({ "conversations.json": "[]" }) }).flavour).toBe("chat_export");
  });

  test("архив больше лимита не берётся", () => {
    const zip = makeZip({ "a.txt": "x".repeat(1000) });
    expect(() => inspectArchive({ file: zip, limits: { ...DEFAULT_LIMITS, maxZipBytes: 10 } })).toThrow();
  });

  test("слишком много файлов — отказ", () => {
    const files = Object.fromEntries([...Array(5)].map((_, i) => [`f${i}.txt`, "x"]));
    expect(() => inspectArchive({ file: makeZip(files), limits: { ...DEFAULT_LIMITS, maxFiles: 3 } })).toThrow();
  });

  test("zip-бомба не берётся", () => {
    // Один и тот же байт сжимается в сотни раз — ровно то, чем валят контейнер.
    const zip = makeZip({ "bomb.txt": "0".repeat(5000000) });
    expect(() => inspectArchive({ file: zip, limits: { ...DEFAULT_LIMITS, maxRatio: 50 } })).toThrow(/бомб/);
  });

  test("не zip — внятная ошибка, а не мусор", () => {
    const notZip = path.join(tmp, "not.zip");
    fs.writeFileSync(notZip, "это точно не архив");
    expect(() => inspectArchive({ file: notZip })).toThrow(/zip/i);
  });
});

describe.if(HAS_ZIP)("смета", () => {
  test("этапы идут в объявленном порядке", () => {
    const zip = makeZip({ "v.ogg": "a", "p.jpg": "b", "a.txt": "c", "d.pdf": "e" });
    const est = estimateWork(inspectArchive({ file: zip }), () => "openai/gpt-4o-mini");
    expect(est.stages.map((s) => s.stage)).toEqual(["text", "document", "image", "audio"]);
  });

  test("вики-база не тратит токены на распознавание", () => {
    const zip = makeZip({ "a.md": "[[b]]", "b.md": "[[a]]" });
    const est = estimateWork(inspectArchive({ file: zip }), () => "openai/gpt-4o-mini");
    expect(est.fastPath).toBe(true);
    expect(est.tokens).toBe(0);
    expect(est.usd).toBe(0);
  });

  test("больше содержимого — больше токенов, времени и денег", () => {
    // Не повторяющийся текст: одинаковые байты сжались бы 1000:1 и упёрлись
    // в защиту от zip-бомбы, а мерить надо смету, а не защиту.
    const prose = (n) => [...Array(n)].map((_, i) => `строка ${i} ${Math.sin(i)}`).join("\n");
    const small = estimateWork(inspectArchive({ file: makeZip({ "a.txt": prose(100) }) }), () => "openai/gpt-4o-mini");
    const big = estimateWork(inspectArchive({ file: makeZip({ "a.txt": prose(20000) }) }), () => "openai/gpt-4o-mini");
    expect(big.tokens).toBeGreaterThan(small.tokens);
    expect(big.seconds).toBeGreaterThan(small.seconds);
    expect(big.usd).toBeGreaterThan(small.usd);
  });

  test("неизвестная модель — честное «цена неизвестна», а не выдуманный ноль", () => {
    const zip = makeZip({ "v.ogg": "x".repeat(100) });
    const est = estimateWork(inspectArchive({ file: zip }), () => "нет/такой");
    expect(est.stages[0].priced).toBe(false);
    expect(est.unpriced.length).toBe(1);
  });

  test("батчи считаются по размеру батча", () => {
    const files = Object.fromEntries([...Array(25)].map((_, i) => [`p${i}.jpg`, "x"]));
    const est = estimateWork(inspectArchive({ file: makeZip(files) }), () => "openai/gpt-4o-mini", {
      limits: { ...DEFAULT_LIMITS, batchSize: 10 },
    });
    expect(est.batches).toBe(3);
  });
});

describe.if(HAS_ZIP)("состояние и отчёт", () => {
  test("обработанные файлы не выдаются повторно", () => {
    const zip = makeZip({ "a.txt": "1", "b.txt": "2", "c.txt": "3" });
    const inv = inspectArchive({ file: zip });
    expect(stageFiles({ inv, stage: "text" }).remaining).toBe(3);
    markEntry({ file: zip, entry: inv.entries[0].name, status: "done" });
    expect(stageFiles({ inv, stage: "text" }).remaining).toBe(2);
  });

  test("выброшенные тоже не возвращаются в очередь", () => {
    const zip = makeZip({ "a.txt": "1", "b.txt": "2" });
    const inv = inspectArchive({ file: zip });
    markEntry({ file: zip, entry: inv.entries[0].name, status: "skipped" });
    const batch = stageFiles({ inv, stage: "text" });
    expect(batch.files.map((f) => f.name)).not.toContain(inv.entries[0].name);
  });

  test("статус перезаписывается, а не дублируется", () => {
    const zip = makeZip({ "a.txt": "1" });
    const inv = inspectArchive({ file: zip });
    const name = inv.entries[0].name;
    markEntry({ file: zip, entry: name, status: "failed", note: "нет ключа" });
    markEntry({ file: zip, entry: name, status: "done" });
    const report = archiveReport({ inv });
    expect(report.done).toBe(1);
    expect(report.failed).toBe(0);
  });

  test("неизвестный статус отбивается", () => {
    expect(() => markEntry({ file: "x.zip", entry: "a", status: "чтотоещё" })).toThrow();
  });

  test("отчёт даёт бар, разбивку и варианты по нераспознанному", () => {
    const zip = makeZip({ "a.txt": "1", "p.jpg": "2" });
    const inv = inspectArchive({ file: zip });
    markEntry({ file: zip, entry: "a.txt", status: "done" });
    markEntry({ file: zip, entry: "p.jpg", status: "failed", note: "нет ключа Vision" });
    const report = archiveReport({ inv });
    expect(report.progressBar).toContain("100%");
    expect(report.done).toBe(1);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].reason).toBe("нет ключа Vision");
    expect(report.unresolved[0].modality).toBe("vision");
    expect(report.unresolved[0].options.length).toBeGreaterThan(0);
  });

  test("состояние переживает перечитывание файла", () => {
    const zip = makeZip({ "a.txt": "1" });
    const inv = inspectArchive({ file: zip });
    markEntry({ file: zip, entry: "a.txt", status: "done" });
    expect(archiveReport({ inv }).done).toBe(1);
    expect(archiveReport({ inv }).done).toBe(1);
  });
});

describe.if(HAS_ZIP)("чтение одного файла", () => {
  test("текст достаётся без распаковки на диск", () => {
    const zip = makeZip({ "a.txt": "привет из архива" });
    expect(readMember(zip, "a.txt", { encoding: "utf8" })).toContain("привет из архива");
  });

  test("несуществующий файл — null, а не исключение", () => {
    const zip = makeZip({ "a.txt": "x" });
    expect(readMember(zip, "нет-такого.txt")).toBeNull();
  });
});
