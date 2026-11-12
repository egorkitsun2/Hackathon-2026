# ТЗ для Шарапата: руководители и маршрутизация

Каталог направлений теперь динамический: см. [дополнение API v0.6](frontend-dynamic-categories.md). Фиксированные подписи ниже описывают только исходные направления; для интерфейса используйте name_ru/name_kz из API.

Backend API описан в [api-contract.md, v0.5](api-contract.md#v05-manager-routing). Frontend в этой задаче не менялся. Все URL ниже имеют префикс `/api/v1`, запросы идут на текущий origin с cookie (`credentials: same-origin`); изменения — JSON и штатная Origin-проверка.

| Экран / действие | Метод и путь | Запрос / результат |
|---|---|---|
| Создать руководителя (admin) | POST /admin/users | `{phone,full_name,department,position,role:"manager"}` → 201 `{data:{user,temporary_password}}` |
| Список руководителей | GET /admin/users?role=manager&page=1&limit=20 | Та же пагинация и employeeView, role=manager |
| Блокировка/активация | PATCH /admin/users/:id | `{is_active:false/true}` → `{data:{user}}` |
| Сброс пароля | POST /admin/users/:id/reset-password | `{}` → `{data:{user,temporary_password}}`; прежнее ТЗ однократного показа и запрета автоповтора применяется и к manager |
| Категории (любая роль после смены пароля) | GET /categories | `{data:["it","procurement","general"]}` |
| Текущие правила (admin) | GET /admin/routing | `{data:[{category,manager_id},...]}`, все три категории |
| Изменить правило | PATCH /admin/routing/:category | `{manager_id:7}` или `{manager_id:null}` → `{data:{category,manager_id}}` |
| Создать обращение (employee) | POST /tickets | Существующие type/title/description плюс category; assigned_to не отправлять |
| Очередь руководителя | GET /manager/tickets?status=new&page=1&limit=20 | `{data:[ticketSummary],pagination:{page,limit,total}}`, только текущие назначения |
| Детали / история | GET /tickets/:id | Существующий ответ плюс category/assigned_to; events и attachments на месте; author только у admin |
| Скачать вложение | GET /tickets/:id/attachments/:attachmentId | Защищённый бинарный ответ по существующему URL; прямой публичный путь не строить |
| Решение руководителя | PATCH /manager/tickets/:id | Существующие `{status,comment?}` и `{data:{id,status,updated_at,event}}` |
| Переназначить (admin) | PATCH /admin/tickets/:id/assignment | `{assigned_to:8}` либо null → `{data:{id,category,assigned_to,updated_at}}` |
| Без исполнителя (admin) | GET /admin/tickets?unassigned=true&status=new | Существующие список/пагинация, дополнительно category/assigned_to |

Категории: it — IT; procurement — Закупки / Сатып алу; general — Общее / Жалпы. Коды фиксированы, подписи добавить в существующие RU/KZ словари. Обычные старые формы могут временно не передавать category: backend использует general. category после создания не меняется. assigned_to — ID руководителя либо null, никаких дополнительных персональных данных в нём нет.

В админ-панели добавить переключение списков сотрудников/руководителей; старый GET /admin/users без role по-прежнему показывает только employee. В форме создания выбирать employee/manager, но не admin. Изменять роль существующего пользователя API не позволяет. В правилах и ручном назначении предлагать только активных manager; убрать назначение через явный null. Сохранённое правило может ссылаться на заблокированного manager: показать это, новые обращения тогда создаются без исполнителя. Менять правило и переназначать старое обращение — два отдельных действия, массового автоматического переназначения нет.

При входе manager использовать существующий `X-Password-Change-Required` и экран смены пароля. После смены открыть отдельную очередь руководителя, не административную панель. Manager не может создавать обращения, загружать файлы, управлять пользователями, правилами или общей статистикой. Employee сохраняет собственный список; admin видит все обращения и может обработать их сам.

Для manager использовать те же карточку, историю, вложения и форму статуса. Допустимы только new → in_review → resolved/rejected. Завершение/отклонение требует комментария 5–2000 символов после trim. При 404 после переназначения закрыть карточку и обновить очередь. 403 FORBIDDEN/ACCOUNT_DISABLED — закрыть недоступный раздел; 401 — вход заново; 403 PASSWORD_CHANGE_REQUIRED — штатная смена пароля. 400 VALIDATION_ERROR — показать ошибку поля (category, manager_id, assigned_to, status, comment); 409 INVALID_TRANSITION — обновить карточку. Не пытаться автоматически исправлять назначения или повторять конфликтующие операции.

API-пример: `PATCH /admin/routing/it` с `{ "manager_id": 7 }`, затем `POST /tickets` с `{ "type":"problem", "title":"Не работает сканер", "description":"Сканер на складе перестал работать.", "category":"it" }`. В ответе создания category=it, assigned_to=7. После ручного переназначения на 8 прежний manager получает 404 на детали, вложения и изменение статуса. Правило IT при этом остаётся 7, если его отдельно не меняли.

Приёмка UI: обе локали, временный пароль/его смена, две разные очереди, фильтр статуса, category без руководителя, переназначение открытой карточки, скачивание вложения новым руководителем, блокировка и повторная активация. Рабочий UI пока требует реализации этого ТЗ; backend не изменяет frontend автоматически.
