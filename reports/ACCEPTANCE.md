# Acceptance-матрица (T12 / M5)

Заполнено 29.09.2026 по обязательной матрице [docs/12-acceptance.md](../docs/12-acceptance.md). Статусы: **PASS** (проверено тестом/на реальном хосте), **PARTIAL** (проверено с честной оговоркой). Ни один критерий не принят «по умолчанию». Полный набор: `bun run check` = typecheck (TS 7.0.2 strict против @opencode/plugin 2.0.18) + **349 тестов** + build; все offline, без ключей и сети.

| ID | Статус | Проверка (где) |
|---|---|---|
| AC-01 | **PASS** | Пакет грузится реальным V2: packaged host smoke M4 (фаза A) и M5 (P1/P2) на opencode v2.0.18/2.0.19; исправленный пакет в исходном каталоге установки с доступным prompt bundle проверен в T13 на v2.0.19; V1/private imports отсутствуют (typecheck против SDK); локальные evidence M4/M5/T13 (не публикуются) |
| AC-02 | **PASS** | Native allow нетронут (M4-A: NATIVE_ALLOW, исполнение без prompt), deny финален (0 evaluate), non-shell → UNKNOWN_ACTION без мутации; lifecycle L01–L04 в `tests/fixtures/lifecycle.jsonl` |
| AC-03 | **PASS** | Binding полного raw command/cwd/source: корпус C60–C65, L15–L18; на хосте — M4-B (`cd . && printf` в DTO против усечённого scanner) и T11 (подменённая драйвером команда оценена по фактической) |
| AC-04 | **PASS** | Stateless вызовы reviewer-модели `{prompt, model}` без session/tools/history: offline — `tests/contract/generate-wiring.test.ts` + adapter spy; live — 7 вызовов T11 (локальный evidence); T13 подтверждает три отдельных `shadow_would_allow`, в том числе на исходном каталоге установки, без raw transport trace (локальный evidence). D3 (14.10.2026): без секции `escalation` — по-прежнему ровно один вызов (`tests/contract/escalation.test.ts`); с цепочкой — последовательные stateless-вызовы, каждый со своей моделью, без history/tools |
| AC-05 | **PASS** | Порог: allow только при всех gates; MEDIUM+/UNKNOWN/несогласованность → ask: assessment-корпус (34) + threshold-матрица `tests/unit/threshold.test.ts` + L05–L11; live: UNKNOWN → RISK_ABOVE_THRESHOLD (M4-B3) |
| AC-06 | **PASS** | Секреты/transcript/raw logs: prefilter C40–C49, consent до LLM (L12–L14, PRIVACY_BLOCKED на реальном generate — M4-C), audit snapshot-тест `tests/unit/audit.test.ts` (записи без команд/ID/путей) |
| AC-07 | **PASS** | Persistent permissions/command/cwd/env не мутируются: spy запрещённых API `tests/contract/adapter.test.ts` + immutable input test; подтверждено хост-секретами M4/M5 (конфиг восстановлен бит-в-бит) |
| AC-08 | **PASS** | Поздний ответ/cancel/unload не меняют decision: L19–L24; TIMEOUT с отбросом позднего результата на реальном хосте — M4-B4 (AbortError, один вызов) |
| AC-09 | **PASS** | Лимиты/audit failure → ask без retry/fallback: L25–L30 + transport errors (429→RATE_LIMIT, PROVIDER_ERROR живьём в T11); audit failure → ask — `tests/unit/audit.test.ts` |
| AC-10 | **PASS** | Повторы/конкуренция/сессии не смешиваются: L15–L18, L23–L24, L31–L33; разные fingerprints в одной сессии — M4-B |
| AC-11 | **PASS** | Секреты/oversized/control-char/несвязанный input/cwd-вне-корня — ноль LLM-вызовов; eligible compound оценивается в пороге: commands-корпус (80, local-stop vs eligible); на хосте sensitive-path → OUTSIDE_SCOPE с нулём вызовов (M4-B) |
| AC-12 | **PASS** | cd/compound regression и plugin-order qualification: M0 S-A–S-E + M4-B (cd-binding) + M5 (P1/P2 на v2.0.19); composition — PARTIAL-факт `ctx.plugin.list()` не видит локальные плагины (квалификация по логам, `compatibility/host-contract.json`) |
| AC-13 | **PASS** | off/shadow/auto корректны, auto не включить случайно: L01, L05–L06, L34–L35; `auto` — отдельное редактирование конфига (schema-enum, дефолт off), кнопок/флагов включения нет |
| AC-14 | **PASS** | Все offline-тесты без ключей и сети: `bun run check` в clean-окружении (349/349); `test:live` намеренно не входит в check |
| AC-15 | **PASS** | Установка/отключение/pin/честный отчёт: `INSTALL.md` (runbook оператора), pins в п. 1, откат п. 5.4; ограничения — п. 6 и `reports/IMPLEMENTATION_STATUS.md` |
| AC-16 | **PASS** | Threshold-потолки: расширение только в пределах схемы; HIGH/CRITICAL/UNKNOWN/LOW-confidence/UNKNOWN-категория не конфигурируемы и не разрешаемы: `tests/unit/threshold.test.ts` + L51–L54 + `tests/unit/config.test.ts` (отклонение расширенного порога) |
| AC-17 | **PASS** (offline; live NOT_RUN) | Эскалационная цепочка D3: триггеры только на неконкретный результат, исчерпание → ask с теми же reason codes, конкретный вердикт/transport/timeout — один вызов, бюджет и margin ступени, лимиты на событие, audit `attemptCount`/`model` решающей ступени, trace v3 `attempts`: `tests/contract/escalation.test.ts` (13) + `tests/unit/config.test.ts` (8); эскалация не обходит потолки AC-16 — итог проходит тот же `mapAssessmentToThreshold` |

Критический критерий docs/12 (unsafe-фикстура не должна получать auto-allow): в корпусе 0 опасных auto-allow; live-часть (честная модель отвечает MEDIUM+ на подсказках MEDIUM+) — **NOT_RUN** (латентность провайдера; локальный evidence T11), поэтому auto pilot ready не заявляется.

Дополнение 14.10.2026 (D1–D3): полный набор — `bun run check` = typecheck + **395 тестов** + build (было 349 на момент заполнения матрицы; +19 — трейс D1/D2, +21 — эскалация D3); новые критерии AC-17 и уточнён AC-04. Host smoke эскалационной цепочки (последовательные generate в одном хуке) и live-эскалация — NOT_RUN, до их выполнения цепочка в production-`auto` не включается.

Дополнение 14.10.2026 (D4): потолок `hookDeadlineMs` поднят до зашитого максимума 120 000 мс — одновременно `maximum` схемы и константа `HOOK_DEADLINE_HARD_MAX_MS` в коде с независимой semantic-проверкой (границы 120000/120001 и sync схема↔код покрыты unit-тестом конфига); набор — typecheck + **396 тестов** + build. Дефолты, пороги auto-allow, потолки ступеней и остальные лимиты не изменены; host smoke/live — NOT_RUN (проводка контроллера не затронута).

## Уровни готовности (без смешения)

- **Core ready — да**: 349 offline-тестов, авто-путь реализован и покрыт.
- **Shadow pilot ready — да**: packaged host smoke (M4, 10/10) + синтетическая live-оценка с согласия оператора (T11, 7 живых оценок, 0 опасных allow).
- **Auto pilot ready — нет**: техпуть подтверждён (P1: мутация allow + исполнение; P2: ask сохранён), но live-распределение на опасных подсказках не измерено и оператор ещё не подтвердил scope/provider/consent/порог (T13).
