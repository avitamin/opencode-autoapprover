# Полный состав комплекта

Версия документации: **2.0.0**. Дата: **25.09.2026**. В поставке **82 файла** (M0 — карточка совместимости; M1 — код плагина, скрипты и offline-тесты; M2 — корпусные тесты; M3 — native reviewer transport; M4 — packaged host smoke с mock generation; T11 — живая модельная оценка; M5 — операторский runbook, auto-smoke и acceptance-матрица; 29.09.2026; D1 — opt-in трейс LLM для замеров, 29.09.2026; D2 — pre-LLM стопы в трейсе, 12.10.2026; D3 — эскалационная цепочка моделей, 14.10.2026). Evidence-протоколы стенда и операторский журнал ведутся локально в `local/` (git-ignored) и в репозиторий не входят.

Начать с `README.md`, `AGENTS.md`, `START_HERE.md` и `prompts/implement-in-opencode.md`. Далее читать документы по текущему milestone из `IMPLEMENTATION_PLAN.md`, не весь архив на каждой итерации.

Здесь 12 технических документов и repo guide в `docs/`, 4 JSON Schema и **168 инертных сценариев**: 80 команд, 34 ответа модели и 54 lifecycle-cases. Есть отдельный ручной smoke из 10 шагов. Корпус — входные данные для будущей реализации тестов, не исполняемые тесты готового плагина.

| Файл | Назначение |
|---|---|
| [.editorconfig](.editorconfig) | Единые UTF-8, LF и отступы. |
| [.gitignore](.gitignore) | Не коммитить ключи, зависимости, локальные отчёты и сборку. |
| [.agents/git-commit-gate.json](.agents/git-commit-gate.json) | Локальные правила проверки допустимых веток и тем коммита для commit workflow. |
| [AGENTS.md](AGENTS.md) | Постоянные правила Codex и OpenCode: границы задач, безопасность, чтение по задаче и проверки. |
| [FILE_INDEX.md](FILE_INDEX.md) | Этот полный указатель файлов. |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Этапы M0–M5 с ограниченными проверками и результатами. |
| [README.md](README.md) | Назначение, решения, ограничения и начало работы. |
| [INSTALL.md](INSTALL.md) | Операторский runbook: pins, установка, ручное переключение режимов, аудит shadow, квалификация и откат (29.09.2026). |
| [SECURITY.md](SECURITY.md) | Граница доверия, недопустимые обходы и раскрытие проблем. |
| [START_HERE.md](START_HERE.md) | Короткий маршрут чтения и первый рабочий этап. |
| [TASKS.md](TASKS.md) | Исполнимый backlog с критериями завершения. |
| [compatibility/README.md](compatibility/README.md) | Как подтвердить установленную комбинацию host/SDK/platform. |
| [compatibility/host-contract.template.json](compatibility/host-contract.template.json) | Незаполненная карточка совместимости; NOT_RUN, без ложных PASS. |
| [compatibility/host-contract.json](compatibility/host-contract.json) | Заполненная M0-карточка: opencode v2.0.18, реальный field mapping, статусы проверок. |
| [docs/01-requirements.md](docs/01-requirements.md) | Функциональные требования, свойства безопасности и scope MVP. |
| [docs/repo-documentation-guide.md](docs/repo-documentation-guide.md) | Правила ведения документации: источники, владельцы тем, проверки и индексация. |
| [docs/02-architecture.md](docs/02-architecture.md) | Компоненты, поток обработки и зависимости. |
| [docs/03-opencode-v2-contract.md](docs/03-opencode-v2-contract.md) | Публичные V2 API и локальная проверка точного SDK mapping. |
| [docs/04-policy-and-threat-model.md](docs/04-policy-and-threat-model.md) | Политика graduated-v1: градации риска, порог оператора, секреты и модель угроз. |
| [docs/05-configuration.md](docs/05-configuration.md) | Два слоя конфигурации, provider reuse и ручное слияние правил. |
| [docs/06-model-and-prompt.md](docs/06-model-and-prompt.md) | Контекст LLM, строгий ответ и защита от инструкций в данных. |
| [docs/07-lifecycle-and-audit.md](docs/07-lifecycle-and-audit.md) | Конкурентность, таймауты, поздние результаты и журналирование. |
| [docs/08-testing.md](docs/08-testing.md) | Уровни тестов, assertions, offline/live разделение. |
| [docs/09-operations.md](docs/09-operations.md) | Установка, ввод в эксплуатацию, диагностика и отключение. |
| [docs/10-decisions.md](docs/10-decisions.md) | Архитектурные решения и причины отказа от лишних компонентов. |
| [docs/11-upstream-evidence.md](docs/11-upstream-evidence.md) | 13 первичных источников с датой проверки и границами знания. |
| [docs/12-acceptance.md](docs/12-acceptance.md) | Матрица требований и итоговые критерии приёмки. |
| [examples/README.md](examples/README.md) | Назначение шаблонов и порядок замены placeholders. |
| [examples/guard.auto.json](examples/guard.auto.json) | Шаблон auto, требующий заполнения и ручной квалификации. |
| [examples/guard.shadow.json](examples/guard.shadow.json) | Неактивный shadow-шаблон без согласия на передачу данных. |
| [examples/opencode.custom-provider.fragment.jsonc](examples/opencode.custom-provider.fragment.jsonc) | Необязательный compatible provider в конфиге OpenCode. |
| [examples/opencode.global.fragment.jsonc](examples/opencode.global.fragment.jsonc) | Фрагмент plugin loading и shell ask; не замена конфига. |
| [prompts/implement-in-opencode.md](prompts/implement-in-opencode.md) | Готовый стартовый промпт реализации. |
| [prompts/reviewer-system.txt](prompts/reviewer-system.txt) | Статическая инструкция модели-проверяющему. |
| [reports/DOCUMENTATION_VALIDATION.md](reports/DOCUMENTATION_VALIDATION.md) | Результаты проверки самого комплекта, не плагина. |
| [reports/AGENTS_GUIDANCE_RESEARCH.md](reports/AGENTS_GUIDANCE_RESEARCH.md) | Официальные источники новой редакции AGENTS.md, решения и проверка сохранности ограничений. |
| [reports/IMPLEMENTATION_STATUS.md](reports/IMPLEMENTATION_STATUS.md) | Фактическое состояние реализации по этапам M0–M5, уровни готовности, неизвестные. |
| [reports/ACCEPTANCE.md](reports/ACCEPTANCE.md) | Acceptance-матрица AC-01..AC-16 из docs/12, привязанная к тестам и evidence (29.09.2026). |
| [reports/model-evaluation.template.json](reports/model-evaluation.template.json) | Незаполненный отчёт оценки выбранной модели. |
| [schemas/assessment.schema.json](schemas/assessment.schema.json) | JSON Schema многомерного градуированного ответа и правил связности. |
| [schemas/audit.schema.json](schemas/audit.schema.json) | JSON Schema минимизированного события аудита. |
| [schemas/config.schema.json](schemas/config.schema.json) | JSON Schema пользовательской конфигурации guard. |
| [schemas/review-input.schema.json](schemas/review-input.schema.json) | JSON Schema минимального model payload. |
| [tests/fixtures/README.md](tests/fixtures/README.md) | Инертность корпуса, fake FS и семантика expected полей. |
| [tests/fixtures/assessments.jsonl](tests/fixtures/assessments.jsonl) | 34 валидных/невалидных ответов и transport failures. |
| [tests/fixtures/commands.jsonl](tests/fixtures/commands.jsonl) | 80 входов: preflight, порог и ожидания честной модели; не запускать команды. |
| [tests/fixtures/lifecycle.jsonl](tests/fixtures/lifecycle.jsonl) | 54 сценария состояния, конкуренции, отказов и threshold-matrix. |
| [tests/manual/opencode-smoke.md](tests/manual/opencode-smoke.md) | 10 ручных smoke-сценариев для реального хоста. |
| [tests/manual/m4-harness-index.ts](tests/manual/m4-harness-index.ts) | M4 harness-плагин: packaged-модули + подменный scripted generate, трейсы вызовов; копируется в staged-среду скриптом упаковки. |
| [scripts/make-package.ts](scripts/make-package.ts) | M4/M5 упаковка: staged-копия плагина вне рабочего дерева (dist, prompts, prod-deps, index.ts-шим) + сценарные скрипты для харнесса. |

## Код плагина и offline-тесты (M1, 28.09.2026)

Зависимости: `@opencode/plugin 2.0.18` (точный pin = версия хоста), `ajv 8.20.0` (единственный валидатор); dev: `typescript 7.0.2`, `@types/bun 1.4.2`. Lockfile: `bun.lock`. Сборка/проверка: `bun run check` (typecheck + 368 offline-тестов, включая корпус 168 фикстур, + build); live-тесты в `check` не входят.

| Файл | Назначение |
|---|---|
| [package.json](package.json) | Пакет `opencode-llm-approval` v2.2.0, scripts `typecheck/test/build/check/test:contract/test:live`. |
| [tsconfig.json](tsconfig.json) | Strict TS для src+tests (noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax). |
| [tsconfig.build.json](tsconfig.build.json) | Emit `dist/` для упаковки. |
| [bun.lock](bun.lock) | Точные версии зависимостей (282 пакета). |
| [src/index.ts](src/index.ts) | Entry: `Plugin.define`, load/registration/cleanup; минимум логики. |
| [src/types.ts](src/types.ts) | Собственные внутренние типы, не копия SDK. |
| [src/json.ts](src/json.ts) | Strict JSON parser: duplicate keys, control chars, BOM, depth, trailing. |
| [src/config.ts](src/config.ts) | Trusted global config: строгий JSON + schema + семантика + freeze; kill-switch const; `effectiveEscalation`/`reviewerChain` (D3). |
| [src/preflight.ts](src/preflight.ts) | Недублирующие локальные gates: binding, unknown-input-keys, size/control, секреты, cwd-in-root, prefixes, consent. |
| [src/assessment.ts](src/assessment.ts) | Валидация ответа модели: strict JSON + schema v2 + coherence; без repair/retry. |
| [src/threshold.ts](src/threshold.ts) | Чистый детерминированный маппинг на allow/ask; потолки структурны. |
| [src/reviewer.ts](src/reviewer.ts) | ReviewerPort + Scripted (тесты) + Unavailable (до M3). |
| [src/audit.ts](src/audit.ts) | JSONL writer: per-process serialize, rotation, 0700/0600. |
| [src/trace.ts](src/trace.ts) | Opt-in LLM-трейс: файлы по UTC-дню, ротация внутри дня, retention, best-effort (D1); записи v2 с pre-LLM стопами (D2). |
| [src/controller.ts](src/controller.ts) | Lifecycle, registry/tombstones, rate/in-flight, deadline, поздние результаты, commit; эскалационная цепочка и трейс попыток (D3). |
| [src/opencode/adapter.ts](src/opencode/adapter.ts) | Единственный SDK-слой: типизированные events, capture/correlation, мутация только effect/message. |
| [src/opencode/generate-reviewer.ts](src/opencode/generate-reviewer.ts) | Stateless native reviewer: один `ctx.generate.text`, модель из конфига, abort/timeout-семантика, классификация transport-ошибок. |
| [tests/helpers.ts](tests/helpers.ts) | Общие фикстуры тестов (config/snapshot/event/conforming-ответ). |
| [tests/unit/json.test.ts](tests/unit/json.test.ts) | 10 strict-JSON случаев. |
| [tests/unit/config.test.ts](tests/unit/config.test.ts) | Валидация конфига: schema, семантика, freeze, inactive; секция `escalation` — дефолты, уникальность, бюджет цепочки, потолок hookDeadline (D3). |
| [tests/unit/threshold.test.ts](tests/unit/threshold.test.ts) | Порог + matrix L51–L54 + структурные потолки. |
| [tests/unit/preflight.test.ts](tests/unit/preflight.test.ts) | Все gates; compound-команды не локальный стоп. |
| [tests/unit/assessment.test.ts](tests/unit/assessment.test.ts) | Syntax/Schema/Coherence; fences/prose/duplicates → ask. |
| [tests/contract/controller.test.ts](tests/contract/controller.test.ts) | 27 сценариев: admission, binding, дубликаты, лимиты, таймауты, commit-семантика, hygiene аудита. |
| [tests/contract/escalation.test.ts](tests/contract/escalation.test.ts) | Эскалационная цепочка (D3): триггеры UNKNOWN/невалидный ответ/LOW confidence, исчерпание, без эскалации на конкретный вердикт/transport/timeout, бюджет ступени, лимиты на событие, audit/trace попыток. |
| [tests/contract/adapter.test.ts](tests/contract/adapter.test.ts) | SDK-маппинг, untouchable effects, dispose, полная цепочка на fake host surface. |
| [tests/contract/generate-wiring.test.ts](tests/contract/generate-wiring.test.ts) | E2e native reviewer через реальную проводку: allow/INVALID_RESPONSE, модельный гейт, TIMEOUT, 429→RATE_LIMIT, отсутствие промпта. |
| [tests/contract/trace.test.ts](tests/contract/trace.test.ts) | Lifecycle трейса: полная I/O-пара на каждом post-LLM исходе; pre-LLM стопы — команда/redaction/тонкие записи; отказ трейса не меняет решение (D1, D2). |
| [tests/unit/generate-reviewer.test.ts](tests/unit/generate-reviewer.test.ts) | Сборка промпта (untrusted-хвост), один вызов, abort до/после, классификация ошибок. |
| [tests/unit/audit.test.ts](tests/unit/audit.test.ts) | Сериализация appends, size-based ротация с retention, отказы append/rotate/healthy. |
| [tests/unit/trace.test.ts](tests/unit/trace.test.ts) | Трейс-writer: дневное разбиение, ротация, retention, отказы, изоляция от audit-файлов (D1). |
| [tests/corpus/commands.corpus.test.ts](tests/corpus/commands.corpus.test.ts) | 80 fixtures: preflight gates + auto-путь с конформным mock. |
| [tests/corpus/assessments.corpus.test.ts](tests/corpus/assessments.corpus.test.ts) | 34 fixtures: strict JSON + schema + coherence + дефолтный порог. |
| [tests/corpus/lifecycle.corpus.test.ts](tests/corpus/lifecycle.corpus.test.ts) | 54 fixtures: полный lifecycle контроллера, тайминги ×1/100, параллельность, интервенции. |

`node_modules/` и `dist/` — воспроизводимые артефакты, в поставку не входят.
