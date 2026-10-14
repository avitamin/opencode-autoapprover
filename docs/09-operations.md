# 09. Установка, ввод в эксплуатацию и отключение

**Команды сборки ниже — целевой интерфейс, который должен реализовать разработчик. В комплекте документации package.json и бинарника пока нет.** Не пытаться устанавливать этот архив как готовый plugin package.

## Что делает разработчик

Создаёт `package.json`, точные dependencies + lockfile, `src`, тесты и пакетируемый export; описывает скрипты `typecheck`, `test`, `build`, `check` и по необходимости `test:contract`, `test:live`. `check` = typecheck + offline tests + build. Live/model/host tests не запускаются незаметно из `check`.

Проверяет не только workspace import, но и собранный/упакованный артефакт. При local install устанавливается проверенная immutable copy вне рабочего репозитория; точная процедура зависит от выбранного пакетирования и фиксируется по факту, без выдуманной команды OpenCode.

## Что делает оператор

1. В существующем OpenCode подключает API-key provider штатным `/connect`, проверяет IDs модели; удостоверяется, что provider доступен в base/global scope. Ключ не передаёт агенту в сообщении и не сохраняет в Git.
2. Создаёт глобальный config guard из shadow-примера, задаёт действительные roots/model/audit directory и осознанно выбирает порог `autoAllow` (старт — консервативный дефолт LOW/READ/HIGH-confidence). Отдельно подтверждает destination/account и разрешение на передачу минимального payload.
3. Вручную сливает plugin/permissions fragment с собственным глобальным конфигом, не удаляя deny; общий shell/ask размещает перед более узкими deny, а не после них. Проверяет отсутствие дублирующей установки и broad allow/режимов обхода permissions.
4. В отдельной тестовой сессии выполняет host smoke с mock reviewer, затем небольшой live shadow smoke. Проверяет сохранность native prompts и timeout path.
5. Только после записанного PASS для точной сборки меняет `mode` на `auto`, перезагружает штатным способом и повторяет позитивный/негативный smoke.

Не требуется Docker, VPS, отдельный backend, reverse proxy, оркестратор, MCP или новая таблица БД. Работа локального плагина не требует изменения firewall.

## Диагностика

| Симптом | Что проверить |
|---|---|
| Ничего не оценивается | Config loaded, mode/kill switch, privacy consent, action shell, incoming ask |
| Команды выполняются без проверки | Effective host allow/override; режим обхода; другой плагин; missing hook |
| Всегда ручной prompt | Reason code; порог `autoAllow` и категория ответа; raw input binding; SDK compatibility |
| Модель видна в сессии, generation не работает | Base/global availability и точный ID; не создавать fallback-сессию |
| Частые timeout | Reviewer latency, host retries, физические in-flight; не увеличивать бездумно budget |
| Audit error | Права, symlink, место на диске, rotation; не отключать audit для автоапрува |
| После обновления auto выключен | Новая сборка требует короткой квалификации и exact version pin |

## Отключение и откат

Перевести guard config в `off` и перезагрузить plugin/host штатным способом. Для аварийного запуска процесса допускается `OPENCODE_LLM_APPROVAL_DISABLE=1`. Удаление plugin entry — ещё один операторский способ. Guard не должен оставлять persistent permissions, поэтому его удаление не требует чистить созданные им allow-rules.

Ранее заданные самим пользователем или другими компонентами persistent permissions существуют независимо: проверять их отдельно. Не утверждать, что выключение плагина вернуло весь OpenCode в безопасную конфигурацию.

Перед обновлением сохранить предыдущий пакет и проверенную version pair. Не удалять credentials и не переписывать весь config. В случае upstream bypass использовать проверенный хост / остановить соответствующие запуски, а не полагаться на выключенный guard.

## Чего нельзя обещать

Нельзя обещать, что in-process guard защищён от своего OS-пользователя, что LLM всегда права, что offline fixtures заменяют реальный host smoke или что aborted HTTP запрос не тарифицируется. В release notes должны быть точные поддерживаемые версии, действующий порог `autoAllow` и его потолки, известные непроверенные платформы и процедура отключения.
