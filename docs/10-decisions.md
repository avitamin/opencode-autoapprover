# 10. Архитектурные решения

| ID | Решение | Причина / отвергнутая альтернатива |
|---|---|---|
| ADR-01 | Native TypeScript / Promise API | Для OpenCode V2 это прямой путь; Go-first из другого harness не переносится механически |
| ADR-02 | Использовать provider OpenCode | Нет второго хранения ключа, интеграций для каждого vendor и отдельного runtime |
| ADR-03 | Stateless generate, не subagent/session | Отдельная модель без tools, approval recursion и утечки transcript |
| ADR-04 | Только incoming ask/shell | Проект помогает подтверждать, а не незаметно меняет уже заданные allow/deny |
| ADR-05 | ~~Auto = local eligibility AND SAFE~~ **superseded by ADR-15** | LLM не может расширить scope или отменить stop-rule |
| ADR-06 | Не auto-deny | Опасные/непонятные запросы оценивает человек; сохраняется пользовательский сценарий |
| ADR-07 | Shadow-first, auto opt-in | До активации видны качество ответов и реальные host semantics |
| ADR-08 | ~~Readonly-v1 и малый recognizer~~ **superseded by ADR-15** | Быстрый работающий срез без притворного понимания произвольной shell-программы |
| ADR-09 | Global policy, installed prompt bundle | Repo content не управляет собственным approval |
| ADR-10 | Native hook, не pending reply/UI | Не появляются гонки с уже опубликованным prompt и особый UI |
| ADR-11 | Нет allow-cache/retry/fallback | Не переносятся решения между контекстами и не растёт скрытая стоимость |
| ADR-12 | JSONL вместо БД/сервиса | Достаточно для локальной диагностики; не обещает tamper-proof audit |
| ADR-13 | Точная host/SDK qualification | Документированный API не заменяет проверку установленной сборки |
| ADR-14 | Без внешних runtime-зависимостей | Новый OpenCode-only проект; переиспользуются идеи, не чужой runtime |
| ADR-15 | Градуированная LLM-оценка вместо recognizer (25.09.2026, решение владельца) | Recognizer покрывал 6 команд и не снимал основную боль — compound-команды всегда оставались ask. Нативные правила OpenCode становятся единственным детерминированным матчингом; плагин оставляет только недублирующие стопы (binding/cwd-root/secrets/size/consent) и авторизует через порог оператора. Реверсия ADR-05 и ADR-08; ADR-06 (нет auto-deny) сохранён. Принятые риски: prompt injection атакует главного оценивающего; гарантия «ноль unsafe auto-allow» становится измеряемым критерием качества модели, а не детерминированным свойством |
| ADR-16 | Один вызов с многомерным ответом | «Разные вопросы» к модели решаются одним JSON (risk/categories/confidence/signals), а не серией запросов: без retry-циклов, дешевле, меньше поверхность инъекций; правило one-call сохранено |
| ADR-17 | Настраиваемый порог со структурными потолками | Оператор выбирает maxRisk/minConfidence/allowedCategories, но HIGH/CRITICAL/UNKNOWN риска, LOW confidence и UNKNOWN-категория не представимы в схеме конфигурации — расширение возможно только до MEDIUM |

## Изменение решений

Фиксировать проблему, самый маленький предлагаемый diff и затронутые acceptance tests. Не добавлять universal provider abstraction «на будущее». Прямой HTTP transport, поддержка MCP, auto для tests/build, сложный shell parser и собственный UI — отдельные будущие решения, не неявные части MVP.

Изменение безопасной границы (порог `autoAllow`, набор локальных стопов, контракт ответа) требует явного согласования владельца и записи ADR; ADR-15 — действующий прецедент такой записи. Исправление SDK mapping и тестов в рамках принятых решений дополнительного проектирования не требует.
