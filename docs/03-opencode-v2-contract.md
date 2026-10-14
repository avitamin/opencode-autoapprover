# 03. Интеграционный контракт OpenCode V2

## Выбранные точки интеграции

Публичные точки: `Plugin.define` из `@opencode/plugin`; `ctx.permission.hook("evaluate", ...)`; `ctx.generate.text(...)`; при необходимости read-only capture через `ctx.tool.hook("execute.before", ...)` и cleanup через `execute.after`. Источники и статус подтверждения: [E1–E4](11-upstream-evidence.md).

Не использовать V1-пакет и старую сигнатуру. Не создавать отдельную сессию для reviewer. Не применять `ctx.session.generate`: проект требует stateless generation без session context.

## Permission admission

Адаптер проверяет входящий эффект и action до любых сетевых действий. Native explicit deny не должен попадать в путь классификации; если тестовый/изменённый хост всё же передал deny, оставить его нетронутым. Входящий allow не проверяется и не меняется. Для ask/shell — полный pipeline проекта.

Hooks хоста могут видеть результат предыдущих hooks. Наличие `ask` само по себе не доказывает, что это первоначальное правило, а не обязательное human-review другого плагина. Поэтому coexistence с другими approval-плагинами не поддерживается без отдельной контрактной проверки. Не пытаться вычислять приоритет по тексту `message`.

## Полный input важнее scanner resources

`resources` — не обещание получить оригинальную shell-программу. Scanner может разбивать/нормализовать строку; в ней могут потеряться cd, substitutions или redirects. Проверять одну первую resource и разрешать всю операцию запрещено.

В M0 выбрать один подтверждённый способ получить исходные аргументы tool. Предпочтение — публичный typed tool hook + стабильная привязка по source. Документированная permission metadata допустима только после проверки конкретного поля в установленном SDK/host. Произвольное `metadata.command` нельзя считать существующим или полным заранее.

Сохранить в compatibility record реальные пути полей для команды, cwd, session/message/tool-call IDs и правила normalisation. TypeScript обязан компилировать этот mapping без `any`. Если unknown input fields могут менять shell/env/sandbox/execution, они делают запрос не eligible.

Документированный контракт input shell-тула квалифицированного хоста: `{command, workdir?, timeout?, background?}`. Ключи `timeout` (number) и `background` (boolean) — envelope исполнения на стороне хоста: они не меняют передаваемой ревьюеру семантики команды, но их значения обязаны входить в binding-fingerprint снапшота — полная привязка сохраняется. Ключ вне контракта или envelope-ключ с нарушенным типом значения → запрос не eligible (`INPUT_MISMATCH`); новый ключ хоста после его обновления — видимый стоп до пересмотра контракта, не молчаливый пропуск.

Raw command передаётся в оценку целиком, включая составные формы (`;`, `&&`, `|`, redirects, подстановки в исходном виде). Все resources должны согласовываться с ней по проверенному mapping. Дополнительные/пустые/несвязанные resources → ask. Никакой склейки нескольких разрешений в одно и никаких «удобных» усечений команды до одного простого сегмента.

## Generation

Плагин всегда передаёт явный model reference. Публичный one-shot маршрут использует base configuration сервера [E3]; модель, доступная только в project-specific config, не считается автоматически доступной для этого вызова. Основной путь настройки — допущенный провайдер в глобальном/base config.

Проверить сигнатуру `ctx.generate.text` на установленной версии. В исследованном HTTP-контракте input описан через `prompt` и `model`; не выдумывать поля `system`, `temperature`, `response_format`, `maxTokens`, `maxRetries` на этом вызове. Инструкция и JSON-данные передаются одним собранным prompt. Настройки модели/variant допустимы только через реально поддерживаемую host configuration.

Финальный request options может поддерживать AbortSignal [E4]; это проверить typecheck и smoke. Abort клиента не доказывает отмену уже начавшегося запроса провайдеру. Никакой предположительной гарантии «после timeout деньги не расходуются».

## Обязательная локальная квалификация M0

| Проверка | Что зафиксировать |
|---|---|
| Load | Фактический binary/build, SDK version, platform, plugin loading |
| Ask / allow / deny | Какие hooks вызваны; исходная команда не исполняется до решения |
| Binding | Full command + cwd + source IDs совпадают для двух параллельных операций |
| Compound / cd | `cd . && printf ...`, pipeline, redirects: нет обхода native permission |
| Stateless model | Используется заданная reviewer-модель, нет session/tools/history |
| Deadline | Медленный mock не меняет event после возврата ask |
| Unload | Регистрации и in-flight lifecycle очищены |
| Plugin order | Нет другого компонента, ослабляющего наши или чужие human gates |

Исследованное issue E9 — повод для regression smoke, а не доказательство, что баг есть или исправлен в вашей версии. При пропущенном hook не внедрять UI-clicker, hard block в другом hook или fork OpenCode как скрытый обход. Зафиксировать unsupported build, ограничить live использование и продолжить независимую реализацию.

Совместимость фиксируется **точной проверенной сборкой**, не выдуманным диапазоном «все 2.x». После обновления хоста повторяется короткий smoke, а не всё проектирование с нуля.
