# Запуск на Windows 11

Требования: Node.js 24.13+ и установленные зависимости backend. Для публичного демо нужен `cloudflared.exe` в PATH. Скрипты совместимы с Windows PowerShell 5.1 и PowerShell 7.

Команды выполняются из корня проекта. `ExecutionPolicy Bypass` действует только на запускаемый процесс PowerShell и не меняет системную политику.

```powershell
cd C:\Workspace\Hackathon-2026
# Только при первой установке или восстановлении зависимостей, после остановки сервера:
npm.cmd --prefix backend ci

# Локально: сайт и API на http://localhost:8787
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1
```

Для демо сначала остановите локальный запуск. При необходимости установите cloudflared по [официальной инструкции](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) и откройте новый терминал.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-demo.ps1
```

Дождитесь `Ready: https://....trycloudflare.com` и используйте именно выведенный адрес. Он новый при каждом запуске. Терминал должен оставаться открытым. Quick Tunnel делает текущий сайт публичным; это временный демонстрационный режим, [без гарантии доступности Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Остановка любого из двух режимов — Ctrl+C в его терминале либо из второго терминала:

```powershell
cd C:\Workspace\Hackathon-2026
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\stop-demo.ps1
```

Повторная остановка безопасна. После принудительного закрытия терминала тоже выполните `stop-demo.ps1`. Скрипт проверяет путь, уникальный маркер, PID и время создания дочерних процессов. Посторонние node/cloudflared и владелец занятого порта не завершаются. При невозможности безопасно проверить процесс служебное состояние сохраняется для повторной остановки.

Оба режима используют один Node-сервер: он отдаёт существующий `Frontend` и API, слушая только `127.0.0.1:8787`. Демо получает фактический URL от cloudflared **до** старта backend и задаёт точный `APP_ORIGIN`, `NODE_ENV=production` и Secure/HttpOnly cookie. Ошибка или неоднозначность URL, отсутствие HTTPS-доступности, завершение backend или туннеля останавливают запуск; подмена origin и автоматический перезапуск отсутствуют.

Seed и bootstrap не запускаются. Существующая SQLite и вложения сохраняются, приложение выполняет только свои обычные миграции. Как и при ручном запуске, явно заданные `DATABASE_PATH` и `ATTACHMENTS_DIR` наследуются; без них используются стандартные пути backend. Остальные переменные запуска выставляются автоматически и не изменяют окружение родительского терминала. Для смены режима нужно заново войти в систему, поскольку cookie локального и HTTPS-режима различаются.

Скрипты не устанавливают зависимости автоматически. Нельзя выполнять `npm ci`, пока сервер использует Argon2: Windows блокирует загруженную нативную библиотеку. Служебные логи и состояние находятся в игнорируемом Git каталоге `backend/.local/launchers`; при остановке удаляются только известные файлы конкретного запуска. Логи не содержат паролей, токенов или тел HTTP-запросов. Логи cloudflared имеют уровень `info`; пользовательская конфигурация и переменные `TUNNEL_*` не используются.

Проверки синтаксиса и вспомогательных функций:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\backend\tests\launchers.test.ps1
```

Если демо сообщает ошибку DNS/HTTPS, оба процесса останавливаются. Адрес не заменяется на localhost. Для диагностики проверьте **выданное в сообщении имя** через `Resolve-DnsName <имя>.trycloudflare.com` и, отдельно, `Resolve-DnsName <имя>.trycloudflare.com -Server 1.1.1.1`. Если ответы различаются, проверьте настройки вашего DNS/VPN/сетевого фильтра. Скрипты не изменяют DNS, hosts и проверку TLS.
