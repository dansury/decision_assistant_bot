#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { lookupCharacter, upsertCharacter } from "./lib/characters.js";
import { writeEntry, searchVault } from "./lib/entries.js";
import { setDecisionOutcome, DECISION_STATUSES } from "./lib/decisions.js";
import { recordFeedback } from "./lib/feedback.js";
import { listModelsByPrice, listFreeModels, recommendModelForLayer } from "./lib/models.js";
import { estimateCost, renderCostCard } from "./lib/cost.js";
import { rememberHandwriting, getHandwritingProfile } from "./lib/handwriting.js";
import { importChatHistory, importChatHistoryFile, historyImportStatus } from "./lib/history.js";
import {
  DEFAULT_LIMITS,
  STAGE_ORDER,
  archiveReport,
  estimateWork,
  humanDuration,
  inspectArchive,
  markEntry,
  readMember,
  stageFiles,
} from "./lib/archive.js";
import { MODALITIES } from "./lib/modality.js";
import {
  LEVELS,
  clearPreference,
  explainPreferences,
  resolveModelForLayer,
  setPreference,
} from "./lib/modelPrefs.js";
import { FOLDERS } from "./lib/paths.js";

const server = new McpServer({ name: "second-brain", version: "0.1.0" });

function asJsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

server.tool(
  "lookup_character",
  "Нечёткий поиск персоны в People/ по имени и (опционально) роли. " +
    "Возвращает кандидатов с score 0..1 — см. Promts/02_entity_recognition.md для правила дизамбигуации.",
  { name: z.string().describe("Имя, как упомянуто в тексте"), role: z.string().optional().describe("Роль/контекст, если известна") },
  async ({ name, role }) => asJsonResult(await lookupCharacter({ name, role }))
);

server.tool(
  "upsert_character",
  "Создать или обновить People/Имя_Фамилия_(роль).md. Идемпотентно по (name, role).",
  {
    name: z.string(),
    role: z.string(),
    aliases: z.array(z.string()).optional().default([]),
  },
  async ({ name, role, aliases }) => asJsonResult(await upsertCharacter({ name, role, aliases }))
);

server.tool(
  "obsidian_write_entry",
  `Записать структурированную запись в vault (lint + frontmatter). type ∈ [${Object.keys(FOLDERS).join(", ")}]. ` +
    "Единственная точка записи в vault, см. Promts/08_obsidian_lint.md.",
  {
    type: z.enum(["journal", "decision", "document", "photo-people", "handwriting"]),
    frontmatter: z.record(z.any()).optional().default({}),
    body: z.string(),
    links: z.array(z.string()).optional().default([]),
    date: z.string().optional().describe("YYYY-MM-DD, по умолчанию — сегодня"),
  },
  async (args) => asJsonResult(await writeEntry(args))
);

server.tool(
  "search_vault",
  "Текстовый/метаданный поиск по vault (дополняет семантический поиск gbrain). Используется слоем 4c для прецедентов " +
    "(status: outcome-good/outcome-bad — решённые прецеденты) и слоем 4f для поиска решения, чей исход сообщил пользователь (status: open).",
  {
    query: z.string(),
    type: z.enum(["journal", "decision", "document", "photo-people", "handwriting"]).optional(),
    status: z.enum(DECISION_STATUSES).optional().describe("Фильтр по frontmatter status (для type: decision)"),
    limit: z.number().int().positive().max(100).optional().default(20),
  },
  async (args) => asJsonResult(await searchVault(args))
);

server.tool(
  "set_decision_outcome",
  "Проставить исход прошлого решения в Decisions/: frontmatter status (open|outcome-good|outcome-bad) + секция «Исход». " +
    "Слой 4f — именно эти статусы делают запись прецедентом для слоя 4c. См. Promts/04f_decision_outcome.md.",
  {
    ref: z.string().describe("path из результата search_vault (Decisions/….md) или [[wikilink]] записи решения"),
    status: z.enum(DECISION_STATUSES),
    note: z.string().optional().describe("Чем закончилось — словами пользователя"),
  },
  async (args) => asJsonResult(await setDecisionOutcome(args))
);

server.tool(
  "record_feedback",
  "Записать 👍/👎 в Wiki/Feedback.md вместе с моделью/слоем/причиной. См. Promts/09_feedback_and_model_switch.md.",
  {
    rating: z.enum(["up", "down"]),
    reason: z.string().optional(),
    model: z.string(),
    layer: z.string().optional(),
    context: z.string().optional(),
  },
  async (args) => asJsonResult(await recordFeedback(args))
);

server.tool(
  "list_models_by_price",
  "Список моделей провайдера по возрастанию цены за промпт-токен — для 👎-флоу слоя 9. " +
    "Бесплатные (isFree) идут первыми; freeOnly=true оставляет только их.",
  {
    provider: z.enum(["openrouter", "yandex"]).optional().default("openrouter"),
    limit: z.number().int().positive().max(100).optional().default(15),
    freeOnly: z.boolean().optional().default(false),
  },
  async (args) => asJsonResult(await listModelsByPrice(args))
);

server.tool(
  "list_free_models",
  "Топ БЕСПЛАТНЫХ моделей OpenRouter (цена $0), отранжированных рейтингом shir-man и суточной квотой. " +
    "Основной ответ на «переключи на бесплатную» в слое 9. modalities=[\"image\"] — только модели с картинками (слои 06/07).",
  {
    limit: z.number().int().positive().max(50).optional().default(10),
    modalities: z.array(z.enum(["text", "image", "file"])).optional().default([]),
  },
  async (args) => asJsonResult(await listFreeModels(args))
);

server.tool(
  "recommend_model_for_layer",
  "Какую модель брать на слой конвейера: некритичные слои (роутер, чистка расшифровки, NER, lint) → " +
    "топ-1 бесплатная OpenRouter, критичные (риски, прецеденты, прогноз, синтез, почерк) → платный дефолт. " +
    "Политика — config/layer_policy.json.",
  { layer: z.string().describe('Имя слоя, напр. "04c_precedents" или короткое "04c"') },
  async (args) => asJsonResult(await recommendModelForLayer(args))
);

server.tool(
  "estimate_model_cost",
  "Оценка стоимости одного вызова модели в USD и рублях (курс — config/fx.json) + готовая карточка цены. " +
    "Показывать перед переключением на платную модель.",
  {
    model: z.string(),
    layer: z.string().optional().describe("Слой — из него берётся ожидаемый размер ответа"),
    promptTokens: z.number().int().nonnegative().optional(),
    promptText: z.string().optional().describe("Альтернатива promptTokens: посчитаем ~4 символа/токен"),
  },
  async (args) => {
    const estimate = await estimateCost({ ...args, promptTokens: args.promptTokens ?? null, promptText: args.promptText ?? null });
    return asJsonResult({ ...estimate, card: renderCostCard(estimate) });
  }
);

server.tool(
  "import_chat_history",
  "Импортировать ВСЮ прошлую историю канала/группы в vault (слой 10), а не только новые сообщения: " +
    "Telegram Bot API историю не отдаёт, поэтому посты берутся с публичного превью t.me/s/<username> " +
    "с пагинацией. Идемпотентно: повторный вызов не дублирует уже импортированное. " +
    "Приватный канал/группа без превью → import_chat_history_file. См. Promts/10_history_import.md.",
  {
    chat: z.string().describe("@username, t.me/username или голый username канала/группы"),
    limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Максимум постов (0 — вся доступная история, по умолчанию)"),
    since_id: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Импортировать только сообщения новее этого id (докачка; max_msg_id из прошлого ответа)"),
    dry_run: z.boolean().optional().default(false).describe("Только посчитать, не писать в vault"),
  },
  async ({ chat, limit, since_id, dry_run }) =>
    asJsonResult(await importChatHistory({ chat, limit, sinceId: since_id, dryRun: dry_run }))
);

server.tool(
  "import_chat_history_file",
  "Импортировать историю из JSON-экспорта Telegram Desktop (Настройки → Экспорт данных → формат JSON). " +
    "Путь для приватных каналов, групп и «Избранного», у которых нет публичного превью t.me/s. " +
    "Идемпотентен так же, как import_chat_history.",
  {
    file: z.string().describe("Путь к result.json (или к папке экспорта) внутри контейнера"),
    chat: z.string().optional().describe("Метка чата в состоянии импорта; по умолчанию — name из экспорта"),
    limit: z.number().int().nonnegative().optional().default(0),
    since_id: z.number().int().nonnegative().optional().default(0),
    dry_run: z.boolean().optional().default(false),
  },
  async ({ file, chat, limit, since_id, dry_run }) =>
    asJsonResult(await importChatHistoryFile({ file, chat, limit, sinceId: since_id, dryRun: dry_run }))
);

server.tool(
  "history_import_status",
  "Что уже импортировано из истории чатов: сколько сообщений, диапазон id, когда был последний прогон. " +
    "Слой 10 — перед повторным импортом и для докачки (since_id = max_msg_id).",
  { chat: z.string().optional().describe("@username/метка чата; без него — все чаты") },
  async ({ chat }) => asJsonResult(await historyImportStatus({ chat }))
);

server.tool(
  "remember_handwriting",
  "Добавить описательные заметки об особенностях почерка персоны (не биометрия). Слой 7.",
  { person: z.string(), notes: z.array(z.string()).min(1) },
  async (args) => asJsonResult(await rememberHandwriting(args))
);

server.tool(
  "get_handwriting_profile",
  "Получить накопленные заметки о почерке персоны для подсказки при расшифровке. Слой 7.",
  { person: z.string() },
  async (args) => asJsonResult(await getHandwritingProfile(args))
);

// --- Выбор модели: три уровня (ТЗ.md §7.1) ----------------------------------

server.tool(
  "set_model_preference",
  "Записать выбор модели на ОДНОМ из трёх уровней. Приоритет: layer > modality > global. " +
    "Уровни хранятся раздельно, поэтому выбор на уровне global НЕ сбрасывает слой или модальность, " +
    "настроенные точечно — это гарантия, а не соглашение.",
  {
    level: z.enum(["global", "modality", "layer"]),
    value: z
      .string()
      .optional()
      .describe(
        `Для level=modality — одна из [${MODALITIES.join(", ")}]; для level=layer — имя слоя ("04c" или "04c_precedents"); для global не нужен`,
      ),
    model: z.string().describe("id модели, напр. openai/gpt-4o-mini"),
  },
  async ({ level, value, model }) =>
    asJsonResult(setPreference({ level, value: value ?? null, model })),
);

server.tool(
  "clear_model_preference",
  "Снять выбор на уровне: слой снова падает на модальность, модальность — на общую модель, " +
    "общая — на политику слоя.",
  {
    level: z.enum(["global", "modality", "layer"]),
    value: z.string().optional(),
  },
  async ({ level, value }) => asJsonResult(clearPreference({ level, value: value ?? null })),
);

server.tool(
  "get_model_preferences",
  "Что сейчас выбрано на каждом уровне и КАКОЙ уровень решил конкретный слой. " +
    "Медийный слой не получает общую модель, если она эту модальность не тянет " +
    "(текстовая модель не расшифрует .ogg) — в ответе тогда есть note с причиной.",
  { layer: z.string().optional().describe("Только про этот слой; без него — про все") },
  async ({ layer }) =>
    asJsonResult({ levels: LEVELS, ...explainPreferences({ layer: layer ?? null }) }),
);

// --- Архивы (слой 11, ТЗ.md §8.4) -------------------------------------------

function inventoryFor(file) {
  const inv = inspectArchive({ file });
  const estimate = estimateWork(inv, (stage) => {
    const layer = { markdown: "08", text: "01", document: "05", image: "06", audio: "01", video: "01" }[stage];
    return resolveModelForLayer(layer).model;
  });
  return { inv, estimate };
}

server.tool(
  "inspect_archive",
  "Посмотреть, что внутри zip, НЕ распаковывая его, и посчитать смету до запуска: виды файлов, " +
    "«вкус» архива (obsidian_vault / telegram_export / chat_export / generic), этапы в порядке " +
    "текст → документы → изображения → голос → видео, токены, время, примерная цена. " +
    "obsidian_vault означает, что распознавать нечего: заметки пишутся как есть и сразу идут в lint. " +
    "Показать смету владельцу и дождаться согласия ПЕРЕД обработкой.",
  {
    file: z.string().describe("Путь к .zip внутри контейнера"),
  },
  async ({ file }) => {
    const { inv, estimate } = inventoryFor(file);
    return asJsonResult({
      file,
      flavour: inv.flavour,
      fastPath: inv.fastPath,
      totalFiles: inv.totalFiles,
      totalBytes: inv.totalBytes,
      byKind: inv.byKind,
      wikilinks: inv.wikilinks,
      skipped: inv.skipped.slice(0, 20),
      notes: inv.notes,
      estimate: { ...estimate, humanDuration: humanDuration(estimate.seconds) },
      stageOrder: STAGE_ORDER,
      batchSize: DEFAULT_LIMITS.batchSize,
    });
  },
);

server.tool(
  "archive_stage_files",
  "Очередной батч файлов одного этапа. Уже обработанные, проваленные и выброшенные пропускаются " +
    "автоматически, поэтому повторный вызов после рестарта продолжает с места остановки, а не с нуля. " +
    "Обрабатывать батчами, а не всё сразу: контейнер маленький.",
  {
    file: z.string(),
    stage: z.enum(["markdown", "text", "document", "image", "audio", "video"]),
    offset: z.number().int().nonnegative().optional().default(0),
    limit: z.number().int().positive().optional().default(DEFAULT_LIMITS.batchSize),
  },
  async ({ file, stage, offset, limit }) => {
    const inv = inspectArchive({ file });
    return asJsonResult(stageFiles({ inv, stage, offset, limit }));
  },
);

server.tool(
  "archive_read_file",
  "Содержимое одного файла архива: текст (для .md/.txt/.json-экспорта) или base64 " +
    "(для картинки/аудио, чтобы скормить мультимодальной модели). Распаковки на диск не происходит.",
  {
    file: z.string(),
    entry: z.string().describe("Имя внутри архива, как его вернул archive_stage_files"),
    as: z.enum(["text", "base64"]).optional().default("text"),
    max_bytes: z.number().int().positive().optional().default(8 * 1024 * 1024),
  },
  async ({ file, entry, as, max_bytes }) => {
    const buf = readMember(file, entry, { maxBytes: max_bytes });
    if (buf === null) {
      return asJsonResult({ entry, error: "файл не читается из архива" });
    }
    return asJsonResult({
      entry,
      bytes: buf.length,
      truncated: buf.length >= max_bytes,
      ...(as === "base64" ? { base64: buf.toString("base64") } : { text: buf.toString("utf8") }),
    });
  },
);

server.tool(
  "archive_mark",
  'Отметить файл: "done" — записан в vault, "failed" — не распознался (пойдёт в отчёт с вариантами), ' +
    '"skipped" — владелец выбросил. Нераспознанный файл в vault НЕ пишется, поэтому «пропустить» ' +
    "буквально означает, что этого файла в базе нет. Состояние переживает рестарт контейнера.",
  {
    file: z.string(),
    entry: z.string(),
    status: z.enum(["done", "failed", "skipped"]),
    note: z.string().optional().default("").describe("Для failed — причина, её увидит владелец"),
  },
  async (args) => asJsonResult(markEntry(args)),
);

server.tool(
  "archive_report",
  "Прогресс разбора: готовая строка прогресс-бара для самообновляющегося сообщения, разбивка по " +
    "этапам и список нераспознанного. По каждому нераспознанному файлу — подходящие под его " +
    "модальность модели с ценой под объём ИМЕННО этого файла и три выхода: сменить нейросеть, " +
    "описать своими словами, выбросить. Технические ошибки показывать только владельцу бота.",
  { file: z.string() },
  async ({ file }) => {
    const inv = inspectArchive({ file });
    return asJsonResult(archiveReport({ inv }));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
