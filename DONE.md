# DONE — second_brain

Append-only журнал закрытых задач: дата + одна строка «что сделано».
`/dev` не читает этот файл в рутинных циклах.

## 2026-08-21

- Выбор модели: порт слоя из GrowthProducer (`src/llm/*`) в `second-brain-mcp` —
  каталог OpenRouter, топ бесплатных (shir-man + нулевая цена), политика
  критичности слоёв, оценка стоимости вызова; 4 MCP-инструмента, 19 тестов.
- Бесплатный каталог в рантайме: cheap-тир `smart_model_routing` по умолчанию =
  топ-1 бесплатная модель OpenRouter (`docker/entrypoint.sh` + `free-top1.mjs`).
- Слой 10 — импорт истории канала/группы: `import_chat_history`,
  `import_chat_history_file`, `history_import_status`, двойная
  идемпотентность (`.state/history-import.json` + ссылка в файле дня).
- Инфраструктура: SessionStart-хук (`scripts/setup_session.sh`), CI для
  MCP-сервера и shell/JSON (`.github/workflows/ci.yml`), `make test`,
  дисциплина `TODO.md` ↔ `DONE.md` + `DEV_PLAN.md` + скилл `/dev`.

## 2026-08-22

- Слито в main всё, что висело в открытых PR: пин версии ядра hermes по digest
  (`config/hermes/base-image.env`, `scripts/hermes-update.sh`), снимки состояния
  тома перед сменой версии (`scripts/state-snapshot.sh`), суточная
  авто-проверка обновлений с PR (`hermes-update.yml`).
- `README.md`: витрина продукта в начале — что бот делает словами владельца,
  пример диалога, честная таблица «что уже работает / что по плану».
- `README.md`: маркетинговая витрина — ASCII-баннер и схемы (проблема →
  решение → круг «запись → база → совет → исход»), позиционирование против
  чат-бота, блок «ваши данные — ваши», кому подходит/не подходит, ссылка на
  живого бота [@decision_assistant_bot](https://t.me/decision_assistant_bot).
  Техническая часть README сохранена целиком ниже витрины.

## Ранее (по истории git)

- M1 — базовый конвейер и vault: слои 0–3, 8, 9, `second-brain-mcp`, персоны,
  Obsidian-vault, feedback.
- M2 — консультант: слой 4 целиком, `set_decision_outcome`, фильтр `status`
  в `search_vault` (исходы решений питают прецеденты 4c).
- Стек: hermes-agent + gbrain + Grafify на amvera, голос через Yandex
  SpeechKit, `/model` с провайдером yandex, `smart_model_routing`.

## 2026-08-23 — архивы (слой 11) и три уровня выбора модели

- **§7.1 три уровня выбора модели**: слой → модальность → общая → политика,
  приоритет 3>2>1. Уровни в разных ключах `$DATA_DIR/model_prefs.json`, поэтому
  выбор «одна модель на всё» физически не может затереть точечный. Общая модель
  не доезжает до модальности, которую не тянет, — слой падает на `default`
  каталога `config/modality_models.json`, и владельцу называется причина.
  `lib/modality.js`, `lib/modelPrefs.js`; `recommend_model_for_layer` теперь
  возвращает и уровень, которым решён слой.
- **§8.4 разбор zip-архивов** (`lib/archive.js`): central directory читается
  своим разбором без распаковки, один файл достаётся `unzip -p`; вкус архива
  (obsidian_vault → сразу lint), защита от zip-бомбы и лимитов, смета по этапам
  до запуска, состояние разбора на томе (рестарт не теряет очередь),
  прогресс-бар, отчёт о нераспознанном с вариантами моделей и ценой под объём
  конкретного файла.
- **8 новых MCP-инструментов**: `set/clear/get_model_preference(s)`,
  `inspect_archive`, `archive_stage_files`, `archive_read_file`,
  `archive_mark`, `archive_report`.
- **`Promts/11_archive_ingest.md`** — поведение слоя, включён в сборку SOUL.md.
- **Ядро hermes** проверено: `v2026.8.19` — свежайший релиз канала `release`,
  пин и Dockerfile сходятся, обновлять нечего.
- `make test`: 121 pass, 0 fail; smoke видит все 23 инструмента.
