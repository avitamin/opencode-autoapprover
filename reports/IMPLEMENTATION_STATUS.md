# Статус реализации

Дата комплекта: 25.09.2026 (v2.0.0). M0 завершён **28.09.2026**.

| Область | Статус |
|---|---|
| Документация и контракты | Подготовлены (v2.0.0) |
| M0 host probe | PASS — load/ask/allow/deny/binding/cd/pipeline/unload на opencode v2.0.18 |
| M1 vertical slice (offline) | PASS — 87 тестов (unit+contract), strict TS, `bun run check` зелёный |
| M1 host smoke (standalone) | PASS — реальный плагин: off/shadow, binding, preflight, аудит; события нетронуты |
| Runtime код плагина | Реализован (src/, 12 модулей); native reviewer transport на `ctx.generate.text` подключён (M3) |
| Typecheck реального SDK | PASS — tsc 7.0.2 strict против @opencode/plugin 2.0.18 |
| Полный corpus fixtures (M2) | PASS — 168/168 (80 commands, 34 assessments, 54 lifecycle) в `bun run check` |
| M3 native generation + надёжность | PASS — offline-e2e через реальную проводку; 349 тестов в `bun run check` |
| Unit/contract runtime tests | PASS — 349 тестов оффлайн (unit + contract + corpus) |
| Реальный host smoke (packaged) | PASS — M4 (28.09.2026): фазы A/B/C, 10/10 сценариев с mock generation; без живой модели |
| Live LLM evaluation | PASS (T11, 28.09.2026, consent): 7 живых оценок в shadow, все конформные и безопасные; redirect/injection NOT_EVALUATED_LIVE (транспорт); guard-конфиг восстановлен mode=off |
| Live LLM evaluation выбранной модели | PARTIAL PASS — 29.09.2026, модель по выбору оператора: три синтетических `shadow_would_allow`; негативные live-сценарии NOT_RUN (локальный evidence) |
| Auto-path на реальном хосте | PASS (T12, 29.09.2026): P1 — мутация `allow` → исполнение `pwd`; P2 — порог → ask без исполнения; mock-ревьюер, хост v2.0.19; локальный evidence |
| Acceptance-матрица AC-01..AC-16 | PASS/PARTIAL — привязана к тестам, `reports/ACCEPTANCE.md` (29.09.2026) |
| Core ready | Да |
| Shadow pilot ready | Да для ограниченного синтетического теста (M4 + T13) |
| Auto pilot ready | Нет — негативные live-сценарии выбранной модели не проверены; T13 не завершена (рабочая конфигурация оператора — локальный журнал) |

## M0 — зафиксированные факты (28.09.2026)

- Хост: `opencode v2.0.18` (CLI-бинарь в `~/.opencode/bin/`), Linux (Ubuntu 24.04), изоляция `run --standalone`; shared-сервис не затрагивался, глобальный конфиг не менялся.
- Подтверждено на реальной сборке: `permission.hook("evaluate")` (ask и allow; deny — финален, хук не вызывается), `tool.hook("execute.before")` даёт ПОЛНУЮ команду до evaluation, `source {type:"tool", messageID, id}` коррелирует с `tool_use.id`, cleanup работает.
- **Критично:** scanner теряет ведущий `cd` (`cd . && printf` → resources `["printf probe_cd"]`) — решение guard'а строится только на полном input.command из tool-capture.
- `@opencode/plugin` не предоставляется плагинам хостом: нужен dependency с точным pin `2.0.18` (M1). Probe шёл plain default export `{id, setup}`.
- Non-interactive `run` авто-reject'ает pending ask; `--auto` не использовался.
- Live `ctx.generate.text` (наличие подтверждено), AbortSignal, поздние ответы, packaged install — NOT_RUN, переносятся в M4.

## M1 — зафиксированные факты (28.09.2026)

Реализовано (`src/`, строгий TS, типизировано против установленного `@opencode/plugin@2.0.18`):

- **SDK-адаптер** — единственное место контакта с SDK: `Plugin.define`, `permission.hook("evaluate")`, `tool.hook("execute.before"/"execute.after")`, `ctx.generate` не используется до M3. Подтверждено из d.ts: `execute.before` несёт `id: Tool.CallID` + `sessionID` + `messageID` → привязка по стабильному ID без эвристик; `generate.text(input, {signal}) → {text}`; `Registration.dispose()`.
- **Регистрации хуков — без await внутри setup**: ожидание регистрации в `setup` не даёт событий (проверено host-smoke); fire-and-forget регистрация + dispose через `Promise.allSettled` работает.
- **Controller** — полный lifecycle по docs/07: admission (только входящий `ask`/`shell`), kill-switch (проверка дважды), config/mode, binding + tombstones (DUPLICATE_EVENT), preflight, rate/in-flight, один вызов reviewer с llm-deadline/abort, strict-валидация ответа, threshold, финальные re-checks, аудит `allow_prepared` до commit; поздние результаты отбрасываются без side effects.
- **Preflight** — только недублирующие стопы; compound/подстановки/redirects не локальный стоп (graded-v1). Секретный prefilter: 10 паттернов (private keys, AKIA/ASIA, gh_/glpat/xox/sk-/AIza, URL-credentials, authorization/bearer literals, key/token assignments).
- **Audit** — минимизированный JSONL вне workspace, per-process serialize, rotation; ошибка append → ask; при invalid config — noop-порт (безопасно).
- **Host smoke (standalone, безвредные команды)**: `off` → `skipped/MODE_OFF`; `shadow` без consent → `ask/PRIVACY_BLOCKED`; `shadow` с consent → `ask/MODEL_UNAVAILABLE` (reviewer transport отсутствует до M3 — ноль сетевых вызовов). Во всех сценариях событие оставлено `ask`, нативные allow/deny не тронуты, записи аудита не содержат команд/ID/путей.
- Проверено: **plugins-запись в конфиге OpenCode должна указывать на каталог с `index.ts`** (файловый путь отклоняется хостом); пример фрагмента обновлён.

Инструменты сборки: bun 1.4.2, TS 7.0.2 (нативный tsgo; `node …/lib/tsc.js` из-за extensionless bin), ajv 8.20.0. Dev-конфиг guard оставлен инертным: mode=off, consent=false.

## M2 — зафиксированные факты (28.09.2026)

Корпус `tests/fixtures/` (168 сценариев) подключён как данные к реальным модулям; все зелёные в `bun run check` (323 теста). Фикстуры выступили спецификацией и вскрыли шесть дополнений к M1:

- **Sensitive-path скан операндов команды** (C40–C48): builtin-компоненты (`.git/.ssh/.aws/.kube/.gnupg/.env/.env.*/id_rsa/id_ed25519`), guard/OpenCode config-каталоги как абсолютные префиксы, operator-префиксы для относительных путей. Лексический скан по whitespace-токенам, не грамматика; только ужесточает. cwd-проверка сохранена отдельно.
- **Консистентность scanner-resources** (C64/C76/C77): каждый resource обязан быть подстрокой полного raw command — детерминированная проверка связанности без семантики.
- **Response byte ceiling до parse** (R26): raw-ответ сверх `maxResponseBytes` → ask без разбора.
- **Инертность summary** (L39): control-символы (включая `\u001b` escape) в пояснении модели → INVALID_RESPONSE.
- **Null-prototype JSON-объекты** (R29): `__proto__`/`constructor` ключи из недоверенного ответа не загрязняют прототип.
- **Новые controller-гейты**: platform-квалификация (HOST_UNVERIFIED, C62/L47), plugin-конфликт (PLUGIN_CONFLICT, L37), доступность модели/варианта (MODEL_UNAVAILABLE без LLM, L30/L43), health аудита до LLM (AUDIT_ERROR, L46), инвалидация поколения SNAPSHOT_CHANGED (L33/L44), маппинг 429 → RATE_LIMIT (L28).

Тайминг-фикстуры lifecycle масштабированы ×1/100 с сохранением отношений (7000/6500 → 70/65ms); интервенции — детерминированные хуки, без sleep-гонок. `expectedLlmCalls` считает только сценарные вызовы, не setup-префилл.

## M3 — зафиксированные факты (28.09.2026)

Native reviewer подключён к реальной проводке; все проверки оффлайн, без сети и ключей. `bun run check` = 349 тестов.

- **SDK-контракт проверен по d.ts установленного `@opencode/plugin` 2.0.18**: `ctx.generate.text(input: {prompt, model?: {id, providerID, variant?}}, requestOptions?: {signal?}) → Promise<{text}>`. Поля `system`/`temperature`/`response_format` не существуют на этом вызове — не выдуманы. `ctx.model.list() → {data: ModelInfo[]}`, вариант — `variants[].id`.
- **`GenerateTextReviewer`** (`src/opencode/generate-reviewer.ts`): ровно один вызов на допущенную оценку, без retry; модель фиксирована конфигом guard; abort до вызова → ноль сетевых; rejection после abort → `timeout` (не transport); ошибки провайдера классифицируются с code (429 → RATE_LIMIT в контроллере), сообщение обрезается 200 символами.
- **Промпт** (docs/06): доверенная инструкция из `prompts/reviewer-system.txt` (грузится относительно каталога плагина через `import.meta.url`), затем явный маркер недоверенности, затем safe JSON-сериализация DTO. Инъекции остаются внутри хвоста-JSON.
- **Гейт доступности модели** (L30/L43): каталог проверяется один раз на setup; `false` — только при доказанном отсутствии модели/варианта; недоступность API каталога не считается отсутствием (нет ложного гейта).
- **Проводка**: `ctx.generate.text`/`ctx.model.list` обёрнуты в адаптере с сохранением binding; отсутствие `generate` на surface или файла промпта → reviewer null → MODEL_UNAVAILABLE → ask.
- **Аудит (T09)**: appends сериализуются; size-based ротация держит current + retainedFiles−1; отказ append/rotate/healthy → ask; `checkWritable` инъектируем (реальный W_OK-probe остался в realDeps).
- Удалён мёртвый `UnavailableReviewer`; dev-guard-конфиг остаётся `mode=off` — реальная передача команд модели по-прежнему заблокирована до consent (M4/M5).

## M4 — зафиксированные факты (28.09.2026, T10)

Packaged host smoke с mock generation (без живой модели и без сети у ревьюера). Локальный evidence оператора, `compatibility/host-contract.json`; трейсы/аудит — одноразовый каталог вне репо.

- **Packaged-поставка**: `scripts/make-package.ts` стейджит dist + prompts + prod-node_modules + index.ts-шим в stage-каталог вне рабочего дерева (дефолт `/tmp/opencode/pkg`) — как установил бы оператор. HOST FACT: entry из `plugins:[dir]` резолвится как `<dir>/index.ts`, `package.json main` игнорируется; без index.ts плагин молчаливо пропускается.
- **Фаза A (packaged, mode=off)**: native allow нетронут (audit NATIVE_ALLOW, исполнение без prompt), native deny финален (0 evaluate; не-shell событие → UNKNOWN_ACTION без мутации), kill-switch → ask/KILL_SWITCH.
- **Фаза B (harness с mock generate, shadow+transmission)**: полный конвейер на реальном хосте — один stateless вызов `{prompt, model}` + AbortSignal на оценку; `shadow_would_allow` для конформного LOW; **binding полной команды** (`cd . && printf …` в DTO против усечённого resources сканера); UNKNOWN → RISK_ABOVE_THRESHOLD; TIMEOUT на 1502ms c отбросом позднего ответа (AbortError, один вызов); две команды в одной сессии — разные fingerprints; sensitive-path (`~/.config/…`) → OUTSIDE_SCOPE с **нулём** LLM-вызовов.
- **Фаза C (packaged, реальный ctx.generate, transmission=false)**: `ask/PRIVACY_BLOCKED` — consent-гейт останавливает передачу до живой модели.
- **Composition**: `ctx.plugin.list()` на v2.0.18 возвращает `[]` для локальных плагинов и не раскрывает хуки — квалификация по логам загрузки (сторонний глобальный плагин permission-хуков не регистрировал). PARTIAL зафиксирован в карточке.
- **Прочие host-факты**: правила permissions — **последнее совпавшее побеждает** (широкие первыми); каталог моделей в project scope отдаёт модели настроенных провайдеров; драйвер run-сессий требует явного `-m` (дефолтная модель может падать по лимитам аккаунта).
- Guard-конфиг разработки менялся пофазно и **восстановлен бит-в-бит** (mode=off); dev-среда smoke не подключена к рабочей сессии.

## T11 — живая модельная оценка (28.09.2026, consent)

- **7 живых оценок** в shadow (recording-харнесс поверх packaged-модулей, реальный `ctx.generate.text`): все ответы — строгий JSON, все конформные LOW/READ/HIGH, порог применён детерминированно, исход `shadow_would_allow`; ни одного авто-allow (shadow), ни одной команды исполнено не было.
- **NOT_EVALUATED_LIVE**: redirect (WRITE-exclusion) и injection-комментарий — транспорт многократно превышал бюджет (окна деградации латентности провайдера); оба сценария остаются покрыты offline threshold-матрицей и корпусом.
- **Находки (host)**: латентность успешных вызовов требовала бы `llmTimeoutMs` с запасом либо более быстрой модели (точные замеры — локальный evidence); прерванный по abort живой вызов не settle'ится до конца процесса — race контроллера глотает штатно, удалённая отмена транспортом не подтверждена; при подмене команды драйвером guard оценивал фактическую команду из tool-capture (binding живьём).
- Мгновенный транспорт-сбой классифицирован → `ask/PROVIDER_ERROR` без retry. Guard-конфиг разработки восстановлен (mode=off, transmission=false). Провайдер, модель и точные замеры — локальный evidence оператора.

## M5 / T12 — сдача (29.09.2026)

- **Финальный auto-квалификационный smoke** (локальный evidence): P1 — packaged-плагин, `mode=auto`, mock-ревьюер: полный конвейер до мутации `ask`→`allow` и **реального исполнения** `pwd` на хосте (первое прямое доказательство auto-пути; в standalone-ране pending ask авто-reject'ается, исполнение возможно только через allow-мутацию). P2 — валидный UNKNOWN → `ask/RISK_ABOVE_THRESHOLD`, команда не исполнена (нативный диалог сохранён). 2/2 PASS, команды безвредные, конфиг восстановлен.
- **HOST FACT**: desktop-хост авто-обновился до v2.0.19 — оба сценария прошли на нём без изменения кода (пин и квалификация остаются за v2.0.18; оператору — повторная короткая квалификация на своей версии, INSTALL.md п. 5.4).
- **Операторский runbook** `INSTALL.md`: pins (opencode v2.0.18, @opencode/plugin 2.0.18, ajv 8.20.0, bun 1.4.2, TS 7.0.2), сборка/staged-установка вне рабочего дерева, guard-конфиг (порог autoAllow + структурные потолки, transmission-consent, llmTimeoutMs 11000–12000 по замерам T11), слияние фрагмента OpenCode (каталог-плагин, порядок permissions), лестница квалификации off→shadow(mock)→shadow(live)→auto, откат (mode=off / env kill-switch / снятие plugins-записи / обновление), честные границы.
- **Acceptance-матрица** `reports/ACCEPTANCE.md`: AC-01..AC-16 привязаны к тестам/фикстурам/evidence. Критический критерий docs/12: offline-часть PASS (0 опасных auto-allow в корпусе), live-часть (честная модель MEDIUM+ на подсказках MEDIUM+) — NOT_RUN по латентности провайдера → **auto pilot ready не заявляется**.

## T13 — reviewer-модель (29.09.2026, оператор)

- Оператор переключил модель ревьюера в guard-конфиге (выбор провайдера/модели — локальный журнал оператора); `loadGuardConfig` на реальном файле → `active`.
- При первом live-прогоне старая installed-копия вернула `MODEL_UNAVAILABLE`: bundled prompt искался в `dist/prompts/` вместо корня пакета. Путь исправлен (`src/index.ts` вычисляет корень пакета из `dist/src/index.js`), упаковщик больше не перезаписывает stage.
- Три синтетических live-оценки в shadow из изолированного root: `shadow_would_allow / RISK_WITHIN_THRESHOLD`; все входящие `ask` сохранены, команды не выполнились. Подробности — локальный evidence.
- `bun run check` после исправления: typecheck, 349 offline-тестов и build PASS. NOT_RUN: негативный live-корпус и auto с новой моделью; T11-замеры латентности относятся к прежней модели и не переносятся.

## D1 — opt-in трейс LLM для замеров (29.09.2026)

- **Что**: по запросу оператора (замеры качества ревьюера с последующим офлайн-анализом более сильной моделью) добавлен выключенный по умолчанию полный трейс LLM-оценок: одна JSONL-строка на каждую оценку, дошедшую до вызова ревьюера, — фактически отправленные `command`/`resources`/`cwdRelative`/`workspaceLabel`, `rawResponse` (сырой ответ; `null` при timeout/transport), `parseOk`, распарсенный `assessment`, `outcome`, `reasonCode`, отдельные `llmLatencyMs`/`totalLatencyMs`, `inputFingerprint` (корреляция с аудитом), `model` с variant и `promptSha256` (provenance промпта).
- **Конфиг**: опциональная секция `diagnostics.llmTrace` (`enabled`, `directory?` → дефолт `audit.directory`, `maxFileBytes?` 64KiB–50MiB дефолт 5MiB, `retainedFiles?` 1–30 дефолт 7); семантика каталога как у аудита (вне workspace roots, не symlink, без `REPLACE_ME`).
- **Файлы**: `trace-YYYY-MM-DD.jsonl` по UTC-дню из timestamp записи (запрошено оператором — делить по дням), ротация внутри дня `trace-YYYY-MM-DD-NN.jsonl` по размеру, retention по числу файлов; 0700/0600; чистятся только собственные `trace-*` файлы, `audit.jsonl` не трогаются.
- **Гарантии**: best-effort и fail-open — трейс пишется после принятия решения, не ожидается на decision-пути, отказ/переполнение трейса не меняет effect (в отличие от аудита, где отказ → ask); pre-LLM ветки (preflight-стопы, duplicates, rate/concurrency) в трейс не попадают. Потолки/gates/auto-путь не изменены.
- **Изменённые файлы**: `schemas/config.schema.json`, `src/types.ts`, `src/config.ts`, `src/trace.ts` (новый), `src/controller.ts`, `src/opencode/adapter.ts` (`makeTrace`-override, `promptSha256`), `tests/unit/trace.test.ts` (новый), `tests/contract/trace.test.ts` (новый), `tests/unit/config.test.ts`, `docs/04`, `docs/05`, `docs/07`, `FILE_INDEX.md`, `TASKS.md`.
- **Проверки**: `bun run check` — typecheck + **368/368** offline-тестов (было 349; +19: writer 8, lifecycle 8, config 3) + build — PASS. Mock-only; трейс на живом хосте — NOT_RUN.
- **Ограничения / следующий шаг**: установленная копия обновляется оператором вручную: пересборка пакета (`scripts/make-package.ts`), обновление копии, добавление секции `diagnostics.llmTrace` в guard-конфиг, рестарт OpenCode (важно: старый dist + конфиг с `diagnostics` → `CONFIG_INVALID` → все ask). Анализ трейсов более сильной моделью — отдельная будущая задача, в D1 не входит.

## D2 — pre-LLM стопы в трейсе (12.10.2026)

- **Мотивация**: аудит оператора показал, что до LLM доходит меньше процента событий: основные стопы — не-shell действия (`UNKNOWN_ACTION`), native allow, вне корней (`OUTSIDE_SCOPE`), binding-mismatch (`INPUT_MISMATCH`) — трейс v1 (только post-LLM пары) оставался почти пустым, и оператор не видел, что именно фильтруется (распределение — локальный журнал).
- **Что**: `TraceRecord` → `traceVersion: 2` — новые `llmCalled: boolean`, `action: string`, `command`/`cwdRelative`/`workspaceLabel` стали nullable. Записи `llmCalled: false` объясняют стоп: preflight-стопы (`OUTSIDE_SCOPE`, `INPUT_MISMATCH`, `PAYLOAD_TOO_LARGE`, `PRIVACY_BLOCKED`) пишут полную команду и resources; `SECRET_DETECTED` — команду/resources редуцирует до `inputFingerprint` (секретоподобный текст не должен попадать в файл трейса — есть тест на отсутствие секрета в сериализованной записи); `UNKNOWN_ACTION` — тонкая запись: имя `action` без команды (snapshot для не-shell действий не существует). Новый приватный `traceStop(...)` рядом с `traceLlm(...)`, тот же fire-and-forget контракт.
- **Не трейсаются** (по плану, согласованному с оператором): `NATIVE_ALLOW`/`NATIVE_DENY` (шум), duplicates, rate/concurrency, конфиг-уровневые стопы (`KILL_SWITCH`, `CONFIG_INVALID`, `MODE_OFF`, `INPUT_UNBOUND`, …) — их покрывает аудит.
- **Не изменено**: конфиг/схема (секция `diagnostics.llmTrace` прежняя), writer/ротация/retention, все gates и пороги, семантика аудита.
- **Изменённые файлы**: `src/types.ts`, `src/controller.ts`, `tests/unit/trace.test.ts`, `tests/contract/trace.test.ts`, `docs/04`, `docs/05`, `docs/07`, `FILE_INDEX.md`, `TASKS.md`.
- **Проверки**: `bun run check` — typecheck + **374/374** offline-тестов (+6 нетто: pre-LLM стопы с командой ×3, редукция секретов, тонкая не-shell запись, native-skip без трейса; «pre-LLM never traced» заменён на «mode off / unbound не трейсаются») + build — PASS. Mock-only; на живом хосте — NOT_RUN.
- **Ограничения / следующий шаг**: установленная копия не пересобрана — оператору пересобрать пакет и обновить копию; в дневных `trace-*.jsonl` будут соседствовать записи `traceVersion` 1 и 2 (различать по полю); для аналитики замеров — `RATE_LIMIT`/`CONCURRENCY_LIMIT` сознательно не трейсаются.

## D3 — эскалационная цепочка моделей (14.10.2026)

- **Мотивация**: запрос оператора — многоступенчатая оценка: быстрый ревьюер с низким reasoning вернул неконкретный результат → переоценить моделью с большим reasoning; задел под будущий роутинг разных видов запросов по разным моделям.
- **Что**: opt-in секция `escalation` (`models` 1–2 ModelRef, `triggerOn` {`unknownRisk`, `invalidResponse`, `lowConfidence`} — все дефолт `true` по решению оператора, `timeoutMs` 500–12000, деф. 9000). Отсутствие секции — поведение байт-в-байт как раньше. Цепочка `[model, ...escalation.models]` выполняется последовательно в состоянии `classifying`: следующий этап стартует только при неконкретном результате предыдущего, живом generation-токене и остатке бюджета ≥ 1000 мс; бюджет ступени клэмпится остатком hook-дедлайна. Транспортные сбои (PROVIDER_ERROR/429), timeout (abort уже сработал) и конкретные вердикты (включая опасные) никогда не эскалируются — это не retry-until-allow. Rate/in-flight — на событие, не на физический вызов. `ControllerDeps.reviewer` → фабрика `reviewerFor(model)`; `makeReviewer(config, model)`; `checkModelAvailable` проверяет всю цепочку (отсутствие любой модели → `MODEL_UNAVAILABLE`, тихого даунгрейда нет).
- **Потолки не изменены**: `autoAllow` и структурные ceilings прежние; итог любой ступени проходит тот же `mapAssessmentToThreshold`. `hookDeadlineMs`: максимум 15000 → 25000 (дефолт 8000 сохранён); новая семантика конфига: уникальность моделей (включая первичную), `llmTimeoutMs + N×timeoutMs ≤ hookDeadlineMs`.
- **Следы**: `AuditRecord` (schemaVersion 2) — `model` решающей ступени + опциональный `attemptCount` (пишется только >1); `TraceRecord` → `traceVersion: 3` — `escalated` и `attempts: [{model, llmLatencyMs, rawResponse, parseOk, assessment}]`, верхние поля зеркалят последнюю попытку, `llmLatencyMs` — сумма. В трейс-файлах смесь v1/v2/v3.
- **Изменённые файлы**: `schemas/config.schema.json`, `src/types.ts`, `src/config.ts`, `src/controller.ts`, `src/assessment.ts` (комментарий), `src/opencode/adapter.ts`, `tests/helpers.ts` (без изменений), `tests/contract/escalation.test.ts` (новый), `tests/contract/{controller,trace}.test.ts`, `tests/corpus/{commands,lifecycle}.corpus.test.ts`, `tests/unit/{config,trace}.test.ts`, `SECURITY.md`, `docs/01/02/04/05/06/07`, `FILE_INDEX.md`, `TASKS.md`.
- **Проверки**: `bun run check` — typecheck + **395/395** (+21: 13 contract эскалации — триггеры, исчерпание, неэскалация конкретных/transport/timeout, бюджет, лимиты на событие, audit/trace; 8 unit конфига — дефолты, уникальность, бюджет, потолок 25000) + build — PASS. Всё offline/mock; host smoke с последовательными generate-вызовами и live-эскалация — NOT_RUN.
- **Ограничения / следующий шаг**: (1) обновлять dist и конфиг вместе: старый dist + секция `escalation` → `CONFIG_INVALID` → все ask; (2) перед включением эскалации в `auto` — packaged host smoke (последовательные generate в одном хуке); (3) рекомендован режим `shadow`+трейс для оценки доли эскалаций (`attemptCount` в аудите) при `lowConfidence: true` — каждая эскалация удваивает стоимость/латентность события; (4) будущий роутинг «разные виды запросов → разные модели» строится на той же фабрике `reviewerFor`, отдельной задачи пока нет.

## Операторские шаги D3 (14.10.2026)

Обновление установленной копии до D3, включение эскалации, расширение workspaceRoots, live-пробы auto-пути и тюнинг лимитов выполнены оператором; протоколы и HOST FACTS — локальный evidence (`local/evidence/`, в репозиторий не входит). Остаточные NOT_RUN для репозитория: живая эскалация-пара (покрыта packaged mock), негативный live-корпус выбранной модели.

## D4 — настраиваемый потолок hook-бюджета (14.10.2026)

- **Мотивация**: запрос оператора — потолок 25 000 мс связывал максимальные цепочки (12 000 + 2×12 000 = 36 000 мс); бюджет должен настраиваться без пересборки плагина при сохранении незыблемого абсолютного максимума.
- **Что**: `limits.hookDeadlineMs` — 1000–120 000 мс, дефолт 8000. Максимум 120 000 мс зашит дважды: `maximum` в `schemas/config.schema.json` (схема скомпилирована в пакет, конфиг её не изменяет) и константа `HOOK_DEADLINE_HARD_MAX_MS` в `src/config.ts` с независимой semantic-проверкой на случай дрейфа схемы; sync-тест не даёт схеме и константе разойтись. Отдельное поле «потолок» в конфиге не вводилось: значение и потолок пишет один и тот же оператор в один доверенный файл — дополнительной границы это не создаёт.
- **Не изменено**: дефолты; потолки ступеней (`llmTimeoutMs`, `escalation.timeoutMs` ≤ 12 000 — максимум цепочки 36 000 мс влезает с запасом); rate/in-flight/размеры; все gates, пороги и семантика дедлайна в `src/controller.ts`.
- **Изменённые файлы**: `schemas/config.schema.json`, `src/config.ts`, `tests/unit/config.test.ts` (граница 120000/120001, sync-тест), `docs/01-requirements.md`, `docs/04-policy-and-threat-model.md`, `docs/05-configuration.md`, `INSTALL.md`, `FILE_INDEX.md`, `TASKS.md`, `reports/ACCEPTANCE.md`; `package.json` 2.1.0 → 2.2.0.
- **Проверки**: `bun test tests/unit/config.test.ts` — 21 PASS; `bun run check` — typecheck + **396/396** offline-тестов (unit + contract + corpus; +1 sync-тест) + build — PASS. Mock-only; контроллер не затронут — host smoke/live — NOT_RUN.
- **Ограничения / следующий шаг**: установленная копия оператора не пересобрана — обновить по INSTALL; значение `hookDeadlineMs` выше 25 000 требует обновлённого dist (старый dist + такой конфиг → `CONFIG_INVALID` → все ask); худший случай ожидания до ask теперь ограничен 120 000 мс — осознанный выбор оператора.

## D5 — баг binding harness-тулколлов (14.10.2026)

- **Мотивация**: воронка живого аудита (14.10) — `INPUT_MISMATCH` 269 событий за историю (21/день): команды harness-сессий (`bun run check`, `docker … && make …`) не доходили до LLM и исполнялись после ручного одобрения; standalone-профиль проходил. Диагностика по живому трейсу: во всех примерах resources непустые и консистентны с командой, session-подусловие gate 2 недостижимо (то же условие раньше даёт gate 1 → `INPUT_UNBOUND`) → единственный живой виновник — `extraInputKeys`.
- **Что**: «известные» ключи адаптера расширены с {command, workdir} до документированного контракта shell-тула квалифицированного хоста: `timeout:number`, `background:boolean` (docs/03, `compatibility/host-contract.json`). Envelope-значения захватываются в `snapshot.envelope` и входят в экспортированный `snapshotFingerprint` — инвариант полной привязки сохранён, ревьюеру по-прежнему передаётся только команда. Ключ вне контракта или с нарушенным типом значения → `INPUT_MISMATCH` (fail-closed на будущие расширения схемы хоста). Мёртвая ветка gate 2 удалена; `PreflightResult.detail` различает `extraInputKeys` / `resourcesEmpty` / `resourcesInconsistent`.
- **Сопутствующее упрочнение трейса (trace v4)**: секретоподобный вход редактируется до fingerprint на любом стопе — до D5 редукция срабатывала только по reason `SECRET_DETECTED`, а секрет-фильтр (gate 4) ниже binding/size-гейтов: команда с секретом и доп. ключом попадала бы в трейс в открытом виде. Регрессионный тест покрывает именно этот случай.
- **Изменённые файлы**: `src/types.ts`, `src/opencode/adapter.ts`, `src/preflight.ts`, `src/controller.ts`, `tests/helpers.ts`, `tests/unit/{preflight,fingerprint,trace}.test.ts`, `tests/contract/{adapter,trace,escalation}.test.ts`, `tests/corpus/*`; docs/03, docs/07, `compatibility/host-contract.json`, INSTALL, FILE_INDEX, TASKS, ACCEPTANCE; пакет 2.2.0 → 2.3.0.
- **Проверки**: `bun run typecheck` — PASS; focused (adapter/preflight/trace/fingerprint/escalation) — PASS; `bun run test:contract` — 314 PASS; `bun run check` — typecheck + **404/404** (+8) + build — PASS. Live (оператор, 14.10 ~14:04Z, локальный evidence `evidence-v2.3.0-install.md`): рестарт сервиса на v2.3.0; harness-команда с `timeout`-ключом → `allow_prepared / RISK_WITHIN_THRESHOLD`, 2941 мс — первый авто-allow в harness-сессии; окно после рестарта — **0** `INPUT_MISMATCH`. Негативный live-контроль (ключ вне контракта) — NOT_RUN, покрыт offline.
- **Ограничения / следующий шаг**: envelope-набор зафиксирован по схеме shell-тула квалифицированного хоста v2.0.18 — новый ключ хоста после обновления даст видимый `INPUT_MISMATCH` (с `mismatchDetail`) до пересмотра контракта. Установленная копия обновлена (`…-v2.3.0-20261014`, живой конфиг переключён, роллбэк `…-v2.2.0-20261014` сохранён); residual `INPUT_MISMATCH` наблюдать в аудите.

## Заполняет агент

Для каждого этапа: созданные/изменённые файлы; команда проверки; фактический результат; версия окружения; ограничения; следующий минимальный шаг. Отдельно отражать, что проверено mock, а что настоящим OpenCode.

## Текущие неизвестные

Версии установленного host и SDK — зафиксированы M0 (v2.0.18), ограниченный T13-smoke выполнен на v2.0.19; public mapping полного tool input — подтверждён (tool.before + source-корреляция). Остались: согласованный production root/privacy для передачи команд; негативный live-корпус выбранной оператором reviewer-модели; перенос host-наблюдений T11 (поздний ответ/abort) на нового провайдера — NOT_RUN.

Эти поля не мешают реализовать offline core, но не должны быть заменены догадками для live auto.
