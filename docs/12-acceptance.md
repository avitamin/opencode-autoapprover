# 12. Критерии приёмки и traceability

## Обязательная матрица

| ID | Результат | Требования | Проверка |
|---|---|---|---|
| AC-01 | Пакет загружается реальным V2, без V1/private imports | FR-01, FR-13 | M0 + packaged host smoke |
| AC-02 | Native allow/deny и non-shell не изменяются, LLM не вызывается | FR-02, SEC-01 | Lifecycle L01–L04 |
| AC-03 | Full command/cwd/source надёжно связаны; mismatch не позволяет allow | FR-03, SEC-04 | Command C60–C65; lifecycle L15–L18 |
| AC-04 | Вызывается именно reviewer model через host provider без tools/history | FR-04, SEC-05 | Adapter spy + live synthetic request |
| AC-05 | Конформная оценка (LOW/READ/HIGH-confidence) даёт allow только при всех gates; MEDIUM+/UNKNOWN/несогласованность — ask | FR-05, FR-06, SEC-02 | Assessment corpus + lifecycle L05–L11 |
| AC-06 | Нет secrets/transcript/raw logs; consent проверяется до LLM | FR-09, SEC-03, SEC-05 | Command C40–C49; L12–L14; audit snapshot test |
| AC-07 | Не меняются persistent permissions/command/cwd/env | FR-07, SEC-01 | Spy запрещённых API + immutable input test |
| AC-08 | Поздний ответ/cancel/unload не меняет decision | FR-12, SEC-06 | L19–L24 |
| AC-09 | Лимиты и audit failure сохраняют ask без retry/fallback | FR-10, FR-11, SEC-07 | L25–L30 + transport errors |
| AC-10 | Повторы/конкуренция/разные сессии не смешиваются | FR-12, SEC-08 | L15–L18, L23–L24, L31–L33 |
| AC-11 | Секреты, oversized/control-char, несвязанный input и cwd вне root не оцениваются моделью (ноль LLM-вызовов); составные команды оцениваются моделью в пределах порога | SEC-09 | Command corpus: local-stop vs eligible |
| AC-12 | cd/compound regression и plugin-order qualification пройдены | SEC-10, FR-13 | Manual S03–S06 |
| AC-13 | `off/shadow/auto` корректны; auto нельзя включить случайно | FR-08, FR-09 | L01, L05, L06, L34–L35 |
| AC-14 | Все offline tests работают без ключей и сети | FR-14 | Clean environment check |
| AC-15 | Есть установка, отключение, pin и честный отчет ограничений | FR-13, FR-14 | Operations + populated reports |
| AC-16 | Threshold-mapping и потолки: расширение порога работает только в пределах схемы; HIGH/CRITICAL/UNKNOWN/LOW-confidence/UNKNOWN-категория не конфигурируемы и не разрешаемы | FR-05, SEC-02 | Unit threshold matrix + L51–L54 |

Номера корпуса заданы для этой версии комплекта; при добавлении тестов не переиспользовать существующие IDs для другого смысла.

## Уровни готовности

**Core ready:** unit/mock/contract tests проходят; auto path реализован, но реальный хост может быть ещё NOT_RUN.

**Shadow pilot ready:** exact host smoke пройден, выбранная модель доступна и synthetic live evaluation выполнена; реальные команды всё ещё требуют пользователя.

**Auto pilot ready:** все обязательные негативные fixtures не дали auto-allow (offline — неконформные ответы, live — честная модель отвечает `MEDIUM`+ на подсказках `MEDIUM`+); host binding/deny/cd/timeout qualification PASS; positive pipeline работает; оператор подтвердил scope/provider/consent/порог и сам включил auto.

Не сводить эти состояния в одно «готово». Невозможность локального live smoke не запрещает завершить core, но запрещает заявить auto pilot ready.

## Сдача разработчиком

Сообщить созданные модули, точные версии, реально выполненные проверки, отдельно NOT_RUN, измеренную модель и corpus size либо отсутствие live evaluation, явные действия оператора и ограничения. Не включать ключи/сырые команды из приватного проекта в итоговый отчёт.

Критический критерий: если любая обязательная unsafe-фикстура (подсказка `MEDIUM`+ с честной моделью, либо неконформный ответ в offline-прогоне) получает auto-allow, релиз не принят независимо от средней точности и скорости модели.
