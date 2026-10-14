# 02. Архитектура

## Поток

```text
OpenCode tools / штатные permissions
             |
             v
       V2 permission adapter
             |
       входящий ask/shell?
         нет | да
   unchanged v
   immutable snapshot + complete tool-input binding
             |
   preflight: binding / cwd-in-root / secret prefilter / size / consent
       fail  | pass
       ASK   v
   bounded stateless LLM call (одна многомерная оценка)
             |
       strict assessment validation + coherence
             |
   детерминированный threshold-mapping (autoAllow оператора)
       вне порога | в пороге
       ASK        v
   final policy / deadline / snapshot checks
             |
       durable local audit attempt
             |
       allow текущей операции ИЛИ штатный ASK
```

Generation не использует рабочую сессию, инструменты или transcript. Такой выбор нужен для отсутствия рекурсивных approvals, минимального раскрытия данных и независимой reviewer-модели. Эскалационная цепочка (D3) — это последовательные stateless-вызовы по той же схеме: контроллер получает ревьюера фабрикой `reviewerFor(model)` для каждой ступени, решение по-прежнему принимает только порог.

## Модули

| Будущий модуль | Ответственность |
|---|---|
| `src/index.ts` | Load, registration, cleanup; минимум логики |
| `src/opencode/adapter.ts` | SDK-типы, capture/correlation, изменение только effect/message |
| `src/config.ts` | Trusted global config, structural + semantic validation (включая потолки `autoAllow`), frozen snapshot |
| `src/preflight.ts` | Binding, cwd-in-root, secret prefilter, size/consent; ничего из нативного матчинга |
| `src/reviewer.ts` | Порты ревьюера; нативный transport — по одному вызову `ctx.generate.text` на модель цепочки, таймер/abort, без истории |
| `src/assessment.ts` | Строгий JSON, duplicate keys, многомерная семантика и связность ответа |
| `src/threshold.ts` | Чистый детерминированный маппинг `risk/confidence/categories` на allow/ask |
| `src/controller.ts` | Конечное состояние, лимиты и итоговая decision function |
| `src/audit.ts` | Минимизированный JSONL, rotation, ошибки без сырого контекста |
| `src/types.ts` | Собственные внутренние типы, не копия SDK |

Разделение логическое; соседние небольшие модули допустимо объединить. Не создавать интерфейс/фабрику для каждого класса и plugin framework внутри плагина.

## Внутренний запрос

Нормализованный input содержит локальный request UUID, correlation key, исходный effect/action, полный raw command (составные команды — целиком, без склейки и «лечения»), все scanner resources, canonical cwd/root и подтверждённые сведения о происхождении input. Для model request из него строится отдельный DTO без session IDs, абсолютного домашнего пути, секретов, произвольной metadata и порогов оператора.

**Корреляция:** ключ должен опираться на реальные стабильные SDK-идентификаторы session + message + tool call, а не на время, «последнюю команду в сессии» или сходство строк. Snapshot tool input снимается в памяти. Не восстанавливать input из журнала диалога.

Если на целевом SDK нельзя надежно получить/связать полную команду, оставить auto недоступным и продолжить тестирование core в shadow/mock. Нельзя заменить доказательство привязки эвристикой ради демонстрации работающего allow.

## Передача решения

До завершения всей проверки объект события не изменяется. Reviewer возвращает данные, но не получает ссылку на mutable event. Только controller, пока request ещё active, может выполнить финальное синхронное присваивание `effect = "allow"`. По остальным путям он сохраняет исходный `ask` и, при необходимости, добавляет короткую локальную причину.

Нельзя разрешать через pending-request reply параллельно hook: это другая lifecycle-модель и ненужные гонки с интерфейсом. Нельзя менять command/cwd/env, чтобы превратить её в безопасную: пользователь одобряет ровно предложенную операцию.

## Доверенная база

Поставленный пакет, глобальный config и prompt bundle — доверенная часть. Runtime не читает `prompts/` из текущего рабочего проекта: при сборке reviewer-инструкция включается в поставленный пакет. Developer-копия и установленная production-копия должны быть разными.

Остальные плагины и shell могут повлиять на фактическое исполнение. MVP поддерживает только проверенную конфигурацию, где guard — единственный плагин, ослабляющий approvals, а другие hooks не подменяют tool input после snapshot. «Поставить наш hook последним» не является универсальным решением конфликта.
