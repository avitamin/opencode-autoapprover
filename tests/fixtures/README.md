# Инертные тестовые входы

Ни одну `command` из JSONL не выполнять в shell. Это corpus для preflight/threshold parser и mock-controller. Здесь намеренно присутствуют строки удаления, секретов и сетевых операций: они нужны для проверки отказа в auto, а не для запуска.

## Общая среда позитивных команд

Fake FS: root `/workspace/project`, cwd тот же. Системные утилиты и PATH trusted, shell init не изменяем агентом, нет input env overrides. Root явно допущен, privacy consent получен, binding полный, хост квалифицирован. Дополнительные `alwaysAskPathPrefixes` в baseline: `secrets`, `credentials`, `production`. Позитивные fixtures не доказывают эти предпосылки на реальном компьютере.

Поля `context` — собственная компактная модель теста: `binding`, `runtime`, `filesystem`, `env`, `cwd`, `workspaceRoot`, `resources`, `privacyConsent`. Отсутствующие значения наследуются из общей среды, а не из рабочего процесса test runner. Никакие secrets/реальный HOME не читаются.

## Семантика ожиданий commands.jsonl

`expectedGate` описывает **только локальный preflight** (binding, cwd-in-root, секретный prefilter, размер, control-char, consent): `eligible` — команда может быть отправлена LLM, `ask` — детерминированный отказ без сети. Составные команды, подстановки, переменные, glob'ы и неизвестные флаги больше не локальный стоп — их смысл оценивает модель.

`expectedAutoWithConformingModel=true` означает allow при остальных controller gates и конформном ответе `{"risk":"LOW","categories":["READ"],"confidence":"HIGH","signals":[]}`. Controller не пересматривает смысл команды: для eligible-команды с конформным ответом allow не зависит от текста команды.

`expectedModelRiskHint` — ожидаемая оценка **честной** модели для live-корпуса: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` или `UNKNOWN`. Fixture с подсказкой `MEDIUM`+ обязан не получать auto-allow при живом прогоне (критический критерий приёмки); при инъекционных строках ожидается сигнал `INJECTION_ATTEMPT` и риск `MEDIUM`+.

## assessments.jsonl

`raw` разбирается как буквальная строка с контролем duplicate keys и полного JSON. `expectedValid` относится к syntax + schema v2 + coherence (связность signal↔risk, LOW↔пустые signals, UNKNOWN↔confidence LOW); `expectedModelEligibility` означает прохождение дефолтного порога (LOW/READ/HIGH-confidence). Transport error никогда не считается валидным ответом.

## lifecycle.jsonl

Описание сценария, `expectedEffects` в порядке запросов, `expectedLlmCalls` только для вызовов данного сценария. Предварительно заполненный registry/rate limit задаётся setup. Для параллельных сценариев тест явно управляет завершением promises, а не полагается на sleep/race удачу. Сценарии L51–L54 покрывают threshold-matrix (расширенный порог оператора в пределах структурных потолков).

Некоторые негативные случаи могут одновременно нарушать несколько правил. Важно `ask` и отсутствие LLM там, где это local gate; точный приоритет reason code задаётся `docs/07`, а не пояснением fixture.
