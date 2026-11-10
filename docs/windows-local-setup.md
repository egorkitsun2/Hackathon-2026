# Windows: зависимости, первый администратор и локальный запуск

Нужны Node.js 24.13+ и npm. Команды — PowerShell. Существующие БД, аккаунты и
историю не удалять. `npm ci` восстанавливает только зависимости по lock-файлу.

## Если npm ci падает с EPERM на argon2.glibc.node

Причина, подтверждённая при этом аудите: работающий Node backend держал нативный
модуль Argon2. Windows не позволяет npm удалить загруженный `.node` файл. npm
уже успел удалить часть node_modules, поэтому исчезли tsc/tsx. Это не ошибка
SQLite и не повод сбрасывать БД, чистить npm cache или менять алгоритм паролей.

1. Остановить backend через Ctrl+C в его терминале. Если запущен `tsx watch`,
   остановить и watcher, чтобы он не перезапустил сервер во время установки.
2. Если терминала нет, определить владельца порта и загруженный модуль:

```powershell
cd C:\Workspace\Hackathon-2026\backend
$backendOwners = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($backendProcessId in $backendOwners) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$backendProcessId" | Select-Object ProcessId,ParentProcessId,Name,CommandLine
    (Get-Process -Id $backendProcessId).Modules | Where-Object { $_.FileName -eq (Join-Path $PWD 'node_modules\argon2\prebuilds\win32-x64\argon2.glibc.node') } | Select-Object FileName
}
```

Останавливать только проверенный процесс именно этого backend. Не применять
`taskkill /IM node.exe /F` или массовую остановку всех Node-процессов: они могут
принадлежать другим проектам. Если сервер использует другой порт, подставить его.
Для чтения модулей процесса могут потребоваться дополнительные права.

3. После освобождения библиотеки восстановить и проверить:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Не запускать сервер параллельно с npm ci. Не удалять `data/`, `.local/`, SQLite
файлы или lock-файл ради исправления зависимости. Если EPERM остался, проверить
другой процесс, использующий ту же библиотеку, и права на файл; не удалять данные
и не отключать средства защиты наугад.

## Первый администратор без длинной команды

Для новой базы, где ещё нет администратора:

```powershell
cd C:\Workspace\Hackathon-2026\backend
npm.cmd run bootstrap:admin
```

Последовательно ввести телефон Казахстана, ФИО, отдел и должность. Пароль
вводить не нужно: он генерируется случайно. Неверный интерактивный ввод поля
можно исправить на следующем приглашении. Ctrl+C/окончание ввода до заполнения
полей отменяет создание. Справка: `npm.cmd run bootstrap:admin -- --help`.
Старые `--phone`, `--full-name`, `--department`, `--position` по-прежнему работают.

Команда применит миграции и сохранит телефон/пароль в
`backend/.local/bootstrap-admin.json`. Открыть файл локально в редакторе;
не публиковать и не отправлять его в логи. Он исключён из Git. На Windows
держать проект и этот файл в каталоге с приватными пользовательскими ACL:
POSIX mode 0600 сам по себе не настраивает Windows ACL.

Если любой администратор уже существует (даже заблокированный), bootstrap
безопасно откажет. Существующего сотрудника он не повышает до администратора.
Не повторять demo seed на имеющейся базе и не удалять базу ради bootstrap.
Для созданных ранее demo-аккаунтов использовать их `.local/test-accounts.json`.

## Запуск обычного сайта

Из backend/, после установки зависимостей:

```powershell
$env:FRONTEND_DIR = (Resolve-Path ..\frontend).Path
$env:APP_ORIGIN = 'http://localhost:8787'
npm.cmd run dev
```

Открыть **http://localhost:8787/**, ввести телефон и пароль созданного admin.
Сервер автоматически применяет недостающие миграции, сохраняя данные.
Не использовать Live Server или отдельный HTTP-сервер для страницы входа:
frontend и API должны иметь один origin. На время работы оставить терминал
открытым; Ctrl+C останавливает сервер. Не запускать вторую копию на том же порту.

Первый admin входит через существующий сайт. Формы управления сотрудниками и
обязательной смены пароля ещё требуют frontend-интеграции:
[ТЗ для Шарапата](frontend-v03-handoff.md). Backend уже проверяет эти ограничения;
не отключать их ради отсутствующей формы.
