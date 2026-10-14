# 11. Источники и границы проверки

Проверено по публичным первичным источникам **25.09.2026**. Тексты документов проекта написаны самостоятельно; большие фрагменты исходников/официальной документации не копируются. SDK symbols — ориентиры для интеграции, а не обещание идентичного контракта во всех V2 builds.

## E1. V2 Plugin API

Источник: [официальное описание плагинов](https://opencode.ai/v2/docs/build/plugins).

Подтверждены нативная регистрация плагина и permission evaluation hook; stateless generation вынесен в отдельный API. Hook получает результат правил перед продолжением операции/публикацией prompt. Configured deny не допускается к ослаблению; входящие allow и ask могут пройти hook. Порядок нескольких hooks имеет значение. Полная shape tool-before payload и полнота произвольной metadata требуют сверки с локальным SDK.

Решение проекта: обрабатывать только ask/shell и оставить все прочие decisions неизменными; не копировать permissive-пример без собственных gates.

## E2. Permissions V2

Источник: [официальные permissions](https://opencode.ai/v2/docs/permissions/).

V2 использует ordered rules с action/resource/effect. Для shell resource формируется scanner; compound command может дать несколько resources. Правила и результирующее решение зависят от порядка. Поэтому одного совпадения с «безопасной» строкой недостаточно, а наличие глобального ask не доказывает effective ask при других override.

Решение проекта: полный tool-input binding, проверка всех resources и host smoke.

## E3. Stateless generate

Источник: [официальный API, раздел generate](https://opencode.ai/v2/docs/api#generate).

HTTP route описан как experimental one-shot generation с base configuration сервера. В запросе представлены prompt и optional model; отсутствующий model позволяет выбрать default. Generation и session generation — разные операции. Это не подтверждает поддержку произвольных sampling/retry/JSON-schema options на вызове.

Решение проекта: всегда явная reviewer-модель, глобальный/base provider, публичный plugin API; не подставлять session context и неизвестные SDK fields.

## E4. Client request options

Источник: [официальный JavaScript client](https://opencode.ai/v2/docs/build/client).

Клиентские операции поддерживают финальные request options с AbortSignal. Применимость к точному plugin generate alias и отмена на стороне inference проверяются отдельно. Отмена ожидания и отмена затрат провайдера не тождественны.

Решение проекта: bounded lifecycle и игнорирование позднего результата независимо от cancellation propagation.

## E5. Model selection

Источник: [официальные модели](https://opencode.ai/v2/docs/models).

Model availability может зависеть от проекта. Model/variant выбираются по реальному каталогу; неизвестные variants нельзя предполагать существующими. Выбор модели сессии не является конфигурацией reviewer.

Решение проекта: фиксированный model reference и проверка доступности именно для stateless base-scope вызова.

## E6. Providers

Источник: [официальные providers](https://opencode.ai/v2/docs/providers).

Предусмотрены штатное подключение через `/connect`, provider settings и custom compatible provider с env credential source. Endpoint и runtime package относятся к конфигурации OpenCode.

Решение проекта: повторно использовать допущенный API-key provider; не извлекать ключ из внутренних файлов. Custom provider example — настройка хоста, не собственный HTTP transport guard.

## E7. Plugin loading

Источник: [официальная конфигурация плагинов](https://opencode.ai/v2/docs/plugins).

Поддерживаются entries для пакетов и локальных путей; есть auto-discovery в plugin directories. Конфигурации могут складываться из нескольких мест.

Решение проекта: одна проверенная установка, production-copy вне изменяемого workspace, никакой случайной второй копии из `.opencode/plugins`.

## E8. V1 migration

Источник: [официальная миграция V1 plugins](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

V1 implementation нельзя перенести в V2 простым перемещением файла. Старые точки расширения требуют адаптации к доменным API V2.

Решение проекта: V2-only, без V1 compatibility layer и копирования старого permission.ask примера.

## E9. Сообщение о cd bypass

Источник: [upstream issue #47356](https://github.com/anomalyco/opencode/issues/47356).

Issue открыт 04.09.2026; при проверке страницы отмечен Open. Автор сообщает о пропуске permission evaluate для команд с ведущим cd в `0.0.0-beta-19086`, macOS/zsh. Это пользовательское воспроизведение в официальном tracker, не независимый аудит и не доказательство состояния установленной у владельца Linux-сборки.

Решение проекта: безвредный regression smoke на точном build; при провале live deployment не квалифицирован. Не обещать исправление и не писать, что проблема обязательно есть во всех V2.

## E10. Сообщение о schema drift

Источник: [upstream issue #43748](https://github.com/anomalyco/opencode/issues/43748).

В августе 2026 сообщалось о расхождении опубликованной config schema с V2 runtime shapes.

Решение проекта: не путать editor diagnostics с подтверждением runtime compatibility; проверять установленную V2 schema/types и реальную загрузку. Не удалять защитные поля ради зелёной подсветки редактора.

## E11. Policies отдельно от permissions

Источник: [официальные policies](https://opencode.ai/v2/docs/policies).

Policies и интерактивные permissions — различные механизмы; policy не является ещё одним пользовательским prompt.

Решение проекта: не переопределять организационные policies и не включать экспериментальную policy-систему как обязательную новую инфраструктуру MVP.

## E12. Внешние обработчики Git

Источник: [официальный git-config, core.fsmonitor](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsmonitor).

`core.fsmonitor` может содержать путь к hook-команде; механизм участвует в обновлении состояния индекса, в том числе для status. Поэтому «только посмотреть Git» не является достаточным основанием для безусловного auto в непроверенном окружении.

Решение проекта: Git в MVP ручной; расширение оформляется отдельно с проверкой конфигурации, внешних обработчиков и версий.

## E13. Конфигурация и preprocessing ripgrep

Источник: [официальный GUIDE ripgrep](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md).

`--no-config` отключает чтение дополнительной конфигурации; `--pre` запускает отдельную команду для обрабатываемых файлов.

Решение проекта: ограниченный профиль требует `--no-config` и не допускает `--pre` или неизвестные флаги. Это локальное ограничение проекта, а не утверждение, что любая другая команда rg опасна.

## Что здесь не проверялось

Не запускался OpenCode пользователя, не читались его provider config и ключи, не typecheck-ились установленные у него SDK types, не измерялась LLM, не проверялся фактический endpoint и не выполнялся живой permission smoke. На этом основании все локальные compatibility/evaluation поля в шаблонах — `NOT_RUN`/null.

Версии зависимостей намеренно не выдуманы. M0 должен закрепить реальные версии и фактический mapping. Подтверждённые публичные integration points не снимают эту небольшую локальную проверку.
