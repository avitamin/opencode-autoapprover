# 07. Жизненный цикл, лимиты и аудит

## Состояния одной оценки

`captured → preflight → classifying → validated → final-check → audit-prepared → committed`.

Из любого незавершённого состояния допустим терминальный `ask` по deadline, отмене, ошибке, unload, смене snapshot или лимиту. Из terminal state нет перехода в committed. `off` и неохватываемые входы завершаются unchanged без classifier.

Каждой оценке присваиваются local UUID, monotonic deadline и generation token. Worker не держит mutable event; он возвращает Assessment. Только callback controller после проверки всех условий один раз меняет исходный ask. Нельзя прикреплять `.then(() => event.effect = "allow")` к проигравшему timeout promise.

Эскалационная цепочка (D3) живёт внутри состояния `classifying`: ступени выполняются последовательно под одним abort-контроллером, generation-токеном и in-flight слотом события. Следующая ступень стартует только при неконкретном результате предыдущей, живом generation-токене и остатке бюджета ≥ 1 000 мс; budget ступени клэмпится остатком hook-дедлайна. Timeout/transport любой ступени и исчерпание цепочки оставляют решение человеку с теми же reason codes, что и одиночная оценка; в аудите `model` — решающая ступень, `attemptCount` (только >1) — число физических вызовов.

## Корреляция и конкуренция

Snapshot содержит полный input и fingerprint модели/policy; correlation key построен на session/message/tool-call IDs, подтверждённых M0. Не хранить глобальный `lastCommand`. Для параллельных A/B не допускается взаимозамена input, cwd, response и effects.

Bounded in-memory registry хранит незавершённые snapshots и короткие tombstones уже завершённых ключей. Повторная обработка того же ключа → ask без нового LLM, а не повтор разрешения по кэшу. Установить TTL 60 секунд и cap 256; переполнение не вытесняет active entries ради allow — новый запрос получает ask. Tombstones не являются долгоживущим allow-cache.

Освобождение snapshots — после tool completion/error либо TTL; при неполученном after-event тоже есть ограничение памяти. Unload инвалидирует generation tokens, abort-ит запросы и освобождает registrations. Поздний resolve/reject ловится, не создавая unhandled rejection и нового side effect.

Ограничение maxInFlight относится к фактическим незавершённым SDK requests, не только ожидающим permission callbacks. Timeout освобождает ожидание пользователя, но не позволяет запускать неограниченную очередь orphan requests.

## Приоритет проверок

Сначала shape/action/effect и kill switch, затем compatibility/config, binding, scope/privacy/size, rate/concurrency/audit availability, LLM-цепочка (первичная модель, затем эскалационные ступени на неконкретный результат; между ступенями — проверка generation-токена и остатка бюджета), schema/semantics/coherence, threshold mapping, deadline/snapshot/kill switch, audit append, синхронный commit. Все проверки делаются для исходного snapshot, не для отредактированной команды.

Конфиг заморожен до reload; reload инвалидирует все старые in-flight tokens. Если среда допускает provider/model transforms во время запроса, изменение доверенного model/provider snapshot также инвалидирует решение. Где наблюдение изменения не гарантировано публичным API, это явно оговорённое ограничение trusted deployment, а не выдуманное событие SDK.

## Аудит

JSONL вне workspace. Минимальные поля определены в `schemas/audit.schema.json`: время, local request ID, необратимый для процесса fingerprint input, mode, outcome, local reason code, выбранные model IDs, latency, версия policy. Идентификаторы сессий, cwd, команда, resources, полный prompt, ключи, env и model reason не пишутся.

`inputFingerprint` = SHA-256 от canonical snapshot с per-process случайной солью; соль не сохраняется в log. Это средство локальной корреляции, **не обещание анонимизации**. Request UUID связывает запись с текущей диагностикой. Секреты не логируются даже на debug level.

Допустимые outcomes: `skipped`, `ask`, `shadow_would_allow`, `allow_prepared`. Перед auto-allow нужно успешно дописать `allow_prepared` и дождаться завершения записи. Затем без дальнейших `await` повторно проверить monotonic deadline/token и выполнить присваивание. При deadline после записи effect не менять: `allow_prepared` не означает, что allow был применён.

Аудит не доказывает, что хост выполнил команду, и не является транзакцией с исполнением shell. Нет требования к fsync на каждый запрос, blockchain, remote logging или tamper-proof storage. Ошибка append/rotation → ask; пытаться записать ошибку в уже неисправный log циклически нельзя.

Rotation: 5 MiB на файл, максимум 3 файла всего по примеру. Создавать каталог/файлы с минимальными правами, не следовать symlink; отказ безопасной подготовки → нет auto. При нескольких экземплярах одного процесса serialize append на writer; отдельным процессам дать уникальные имена файлов, не вводить SQLite/distributed lock. Лимиты по процессам не являются глобальными лимитами аккаунта.

## Трассировка LLM (opt-in diagnostics)

`diagnostics.llmTrace` (docs/05) включает отдельный локальный JSONL-трейс: одна запись (`traceVersion: 4`) на каждое решённое событие. Общие поля: время, `llmCalled`, `inputFingerprint` (тот же, что в аудите, — для корреляции), mode, model с variant, `action`, `command`/`resources` (с учётом редукции секретов), `promptSha256`, outcome, reason code (для `INPUT_MISMATCH` — уточнение `mismatchDetail`: `extraInputKeys` / `resourcesEmpty` / `resourcesInconsistent`), `totalLatencyMs`. Для `llmCalled: true` дополнительно: отправленные ревьюеру `cwdRelative`/`workspaceLabel`, `llmLatencyMs` (сумма по попыткам), `rawResponse`/`parseOk`/`assessment` последней попытки, `escalated` и массив `attempts` — по одной записи на физический вызов (модель, `llmLatencyMs`, сырой ответ, результат парсинга, вердикт); верхний `model` — решающая ступень.

Отличия от аудита: трейс пишется **после** принятия решения и best-effort — append не ожидается на decision-пути, отказ или переполнение трейса не меняет effect и не создаёт ask. Охват: post-LLM исходы (`llmCalled: true`, включая все эскалационные попытки) и pre-LLM стопы (`llmCalled: false`, `attempts: []`): preflight-стопы — с полной командой; секретоподобный вход редактируется до `inputFingerprint` на любом стопе — секрет-фильтр префлайта срабатывает позже binding/size-гейтов, поэтому редукция не привязана к reason code; не-shell действия (`UNKNOWN_ACTION`) — тонкой записью `action` без команды. Не трейсаются: нативные skip (`NATIVE_ALLOW`/`NATIVE_DENY`), duplicates, rate/concurrency, конфиг-уровневые стопы — их покрывает аудит. Файлы: `trace-YYYY-MM-DD.jsonl` по UTC-дню из timestamp записи, ротация внутри дня `trace-YYYY-MM-DD-NN.jsonl` по размеру, retention по общему числу файлов; каталог 0700, файлы 0600, чистятся только собственные `trace-*` файлы. В дневном файле могут соседствовать записи `traceVersion` 1/2/3/4 — различать по полю. Содержимое чувствительно (текст команд, включая не переданные провайдеру, и ответы каждой модели цепочки): не публиковать; по умолчанию выключено.

## Диагностика

Reason codes — конечное перечисление; подробности ошибок очищаются и не включают request/response dump. Безопасные сообщения объясняют причину и следующий шаг: например, «Модель недоступна; проверьте provider/model в глобальном OpenCode; команда ожидает ручного подтверждения». Не советовать отключить permissions, запускать yolo или включать широкое allow.
