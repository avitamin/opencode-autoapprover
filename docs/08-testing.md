# 08. Проверки

## Уровни

| Уровень | Содержание | Ключ/сеть |
|---|---|---|
| Unit | Preflight, threshold-mapping, schema, coherence, pure decision | Нет |
| Contract/mock | SDK events, correlation, timing, mutations, failure injection | Нет |
| Host smoke | Plugin load, реальный native ask, source binding, cd/compound regression | Нет для mock reviewer |
| Live model evaluation | Синтетические payload, выбранная API-модель, измерение отказов/latency | Только после явного согласия |

Unit/contract CI должен завершаться без ключей и внешних сервисов. Fixtures читаются как данные. Негативные shell-строки никогда не передаются в shell, eval, subprocess или реальный инструмент хоста.

## Корпус

`commands.jsonl` задаёт preflight и threshold cases. У fixture есть `id`, `command`, `context`, `expectedGate`, `expectedAutoWithConformingModel`, `expectedModelRiskHint`, `reason`. `expectedGate` описывает только локальный preflight (binding/scope/secrets/size/consent); составные команды и неизвестные флаги больше не локальный стоп. `expectedAutoWithConformingModel=true` означает allow при остальных controller gates и конформном ответе `LOW / READ / HIGH-confidence`; контроллер не пересматривает смысл команды. `expectedModelRiskHint` — ожидаемая оценка честной модели (`LOW`..`UNKNOWN`, сигналы/категории в `reason`) для live-корпуса: fixture с подсказкой `MEDIUM` и выше не должен получать auto-allow при живом прогоне. Позитивные случаи предполагают проверенную runtime/FS-среду из fixture README, а не доказательство безопасности команды в любом каталоге.

`assessments.jsonl` задаёт буквальный `raw` ответ модели либо transport failure и ожидаемую локальную валидацию (syntax + schema v2 + coherence). Кандидаты с невалидным JSON и duplicate keys должны обрабатываться именно как строки, иначе parser потеряет материал теста.

`lifecycle.jsonl` задаёт события/состояния, ожидаемый effect и число LLM-вызовов. Это сценарии для test runner, не сырые native SDK messages. Адаптер должен иметь отдельные тесты с реальным SDK type mapping.

## Ключевые assertions

Входящий allow/deny/non-shell неизменяем. Локальный stop → ноль LLM-вызовов. Обязательные негативные сценарии → ноль auto-allow (offline: через неконформные ответы; live: честная модель обязана отвечать `MEDIUM`+ на подсказках `MEDIUM`+). Только конформная оценка при всех gates → allow. Конформный LOW-ответ не отменяет secrets, scope, consent и alwaysAsk. Threshold-matrix: `maxRisk=MEDIUM`, `minConfidence=MEDIUM` и расширенные `allowedCategories` покрываются отдельными unit-случаями (L51–L54); потолки схемы проверяются на невозможность конфигурации HIGH/CRITICAL/UNKNOWN.

Отдельно тестировать: две параллельные команды в одной сессии; похожие строки в разных сессиях; late конформный ответ после timeout; unload; missing source; scanner/raw mismatch; event input change; audit append fail; rate limit; memory cap; repeated event; разный byte length при Unicode; malicious model summary; provider error при известном ключе; отсутствие API-key permission на фактическом endpoint.

Проверять **полученный объект native event** после settle и после позднего resolve — не только returned internal decision. Spy на инструмент хоста должен доказывать отсутствие исполнения до разрешения в simulated contract.

## Live evaluation

Не отправлять реальные команды из приватного репозитория до consent. Использовать небольшую выбранную выборку synthetic positives/negatives, не тысячи запросов. Сначала offline corpus полностью зелёный. Один проход live matrix; провалы исправлять адресно, не запускать cost-heavy whole-suite после каждого изменения.

В отчет внести: точный model/provider/variant, дату, prompt hash, размер выборки, распределение ответов по `risk`/`categories`/`confidence`, число invalid/incoherent responses, missed-safe, **unsafe auto-allow** (автоапрув на fixture с подсказкой `MEDIUM`+), latency median/p95 и timeout count. Цена/токены — только если реально доступны, иначе null / not measured.

Критерий безопасности: zero unsafe auto-allow на обязательном корпусе (fixture с `expectedModelRiskHint` ≥ MEDIUM не получает allow). Критерий полезности: хотя бы позитивный минимальный набор демонстрирует auto при конформной оценке; долю отказов LLM сообщить, но не «улучшать» удалением stop-rules или повышением порога. Нулевая ошибка на конечной выборке не равна доказательству общей безопасности.

## Регрессионный smoke

См. `tests/manual/opencode-smoke.md`. В проверках cd/pipeline использовать только безвредные операции над пустым тестовым каталогом. Если хост обходит gating, остановить smoke до любых опасных действий. Проверка не должна автоматически включать production auto или сохранять новые permissions.
