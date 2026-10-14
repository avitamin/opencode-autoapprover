# План реализации: небольшой работающий плагин

Не оценка сроков и не фоновый процесс. Этапы выполняются последовательно в репозитории; после каждого остаётся проверяемый результат.

## M0. Зафиксировать настоящий host contract

Прочитать `docs/03` и источники. Зафиксировать build, SDK, платформу, public methods и full-input correlation. Сделать один небольшой probe-plugin и безвредный smoke в отдельном тестовом каталоге; не менять профиль пользователя. Заполнить compatibility template реальными данными.

Результат: точные dependency versions и mapping либо конкретный локализованный blocker. Проверить только load, ask/allow/deny, binding, cd/compound, stateless generate signature и abort. Не расследовать все подсистемы OpenCode и не исследовать аналоги.

Если инструмент/среда недоступны, перейти к M1/M2 на typed boundary + mock и оставить host/live auto `NOT_RUN`. Не выдавать mock за настоящий smoke; не выполнять guess-based auto.

## M1. Vertical slice без live API

Создать package, strict TS, scripts и минимальный plugin lifecycle. Подключить trusted config, incoming effect/action admission, pure controller и mock reviewer. Реализовать off/shadow/auto-path, но на живом хосте оставить shadow.

Результат: tests подтверждают untouched allow/deny, ask при ошибках и allow только в изолированном mock при валидном SAFE и остальных gates. Список dependencies минимальный.

## M2. Preflight, schemas и независимые fixtures

Реализовать preflight (binding, cwd-in-root, secret prefilter, oversized/control-char, consent), strict JSON parser/validator с duplicate-key detection, многомерную семантику ответа (risk/categories/confidence/signals + coherence) и чистый threshold-mapper `autoAllow`. Отказ при неполном input. Подключить все `commands.jsonl` и `assessments.jsonl`.

Результат: конформный LOW-ответ модели не обходит локальные стопы; потолки схемы не позволяют сконфигурировать HIGH/CRITICAL/UNKNOWN; fixtures исполняются как данные. Позитивные случаи тоже проверены: не сделать guard, который всегда ask и только поэтому «безопасен».

## M3. Native generation и надёжность

Подключить `ctx.generate.text`, явную модель и minimal prompt. Добавить deadline/abort, rate/concurrency cap, no-retry, late-result handling, token invalidation, registry cleanup и минимальный audit. Пройти lifecycle corpus и fake failures.

Результат: один stateless request на допущенную оценку, отсутствие session/tools/history/key extraction; audit failure не даёт allow. Локальное завершение timeout не открывает unlimited orphan calls.

## M4. Host smoke и shadow pilot

Проверить упакованный plugin на точно выбранном host/SDK. Пройти manual script: real native prompt, source mapping, concurrent commands, cd/pipeline, deny unchanged, timeout and unload. Использовать mock generation для host-only smoke. Live model synthetic test — отдельно и только после consent.

Результат: заполненные `compatibility/host-contract.json` и evaluation report либо конкретные FAIL/NOT_RUN. Не пытаться обойти host defect альтернативной точкой принудительного allow.

## M5. Ограниченный auto pilot и сдача

Подготовить операторскую инструкцию установки вне рабочего дерева, конфигурацию (включая осознанный выбор порога `autoAllow`) и откат. Auto-path полностью проверен; пользователь сам активирует его для admitted root. Проверить positive auto и negative native prompt без опасных команд.

Результат: `docs/12` выполнен на заявленном уровне готовности; package/install docs актуальны; точные versions pinned; отчёт не смешивает core ready и auto ready.

## Сдерживание накладных расходов

На текущем этапе — focused tests; полный offline `check` после завершения этапа, один финальный packaged smoke. Live model корпус небольшой, explicit opt-in; без бесконечных retry и нескольких агентов-рецензентов. Единственный review перед сдачей — предметный diff-review критического пути, а не повторное проектирование.

Оператор вручную выполняет подключение ключа, слияние global config, утверждение root/provider, включение auto и при необходимости restart. Код не автоматизирует эти разовые действия скрытно.
