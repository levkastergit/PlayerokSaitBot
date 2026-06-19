# Роблокс-автовыдача (метод свизера / Microsoft Store) — статус и размышления

Заметки для продолжения в новой сессии. Здесь — что выяснили, что работает, что дальше.
Дата последнего апдейта: 2026-06-19.

## ⚠️ Реалити-чек 2026-06 (по веб-исследованию, с источниками)
1. **Резервный метод game-pass УМЕР.** Roblox 2026-05-29 отключил cross-game продажи пассов и
   dev-продуктов (DevForum «Disabling cross-game sales… Transfers API»). Перевод Robux покупкой
   чужого гейм-пасса больше НЕ работает — поэтому код game-pass удалён из репо целиком. Замена
   (Transfers API) непригодна для ресейла: нужен Roblox Plus + проверка возраста 18+, лимиты
   **500 R$/день, 1000 R$/мес**, получателю 90% (без DevEx).
2. **Покупка Robux в приложении MS Store за баланс MS — РАБОТАЕТ ЧАСТИЧНО / нестабильно.** Xbox Wire
   (2025-09-12) подтверждает покупку за Microsoft-баланс; но модератор MS (2026-06-13) и ряд веток
   MS Q&A сообщают, что опция «Microsoft Account Balance» в чекауте появляется НЕ у всех (регион /
   версия приложения GDK vs legacy / привязка аккаунтов). Есть баг: платёж проходит, Robux не
   зачисляются (DevForum, с 2025-05-31, не закрыт) — всегда сверяй `account.microsoft.com/billing/orders`
   = Completed перед зачётом покупателю.
3. **Смена аккаунта-получателя ≠ просто Disconnect на странице безопасности.** Приложение MS Store
   логинит тот Roblox-аккаунт, что привязан к Microsoft-аккаунту, ВОШЕДШЕМУ В WINDOWS/XBOX.
   Disconnect на roblox.com/my/account#!/security часто **сам привязывается обратно** при следующем
   входе. Реальный рычаг — **выйти из Microsoft-аккаунта в Windows/Xbox** (или сменить пользователя
   Windows) перед входом в новый. Disconnect необходим, но недостаточен.
4. **Cookie .ROBLOSECURITY:** привязана к IP-РЕГИОНУ с 2022-03-08 (смена региона = сброс, логин
   заново; не отключается). Формат+ротация изменены **2026-05-01** — надо читать `Set-Cookie` на
   каждом ответе и обрабатывать 401, иначе автоматизация ломается.
5. **«Генератор старых ссылок входа» = authentication-ticket.** Живой хост — `auth.roblox.com/v1/
   authentication-ticket` (НЕ `apis.roblox.com/auth/v1/...`): get CSRF → POST `/v1/authentication-ticket/`
   (тикет в ОТВЕТНОМ заголовке `rbx-authentication-ticket`) → POST `/v1/authentication-ticket/redeem`
   `{authenticationTicket}` + заголовок `RBXAuthenticationNegotiation: 1` → новая cookie в `Set-Cookie`.
   В 2026 работает частично: redeem валидирует IP источника (генераторы шлют `Roblox-CNP-True-IP`).
   **Лучше — Quick Login** (`apis.roblox.com/auth-token-service/v1/login/create|status` → `auth.roblox.com/v2/login`
   `{ctype:'AuthToken',cvalue:code,password:privateKey}`): официальный, без капчи; но проверяет
   сеть/IP при подтверждении кода.

## Новый инструмент (шаги 2-4): `automation/web_xbox_disconnect.py`
Selenium-скрипт: чистый профиль (сброс прошлой сессии) → вход → страница security → проверка/отвязка
Xbox. **Вход по логину/паролю** (`--username/--password` или env `ROBLOX_USER/ROBLOX_PASS`):
браузер видимый, при FunCaptcha/2FA решаешь руками в окне (ждёт `--login-wait`, по умолч. 180с),
после входа можно достать `.ROBLOSECURITY` (`--emit-cookie`) для переиспользования без повторной капчи.
Запасной вход — по cookie (`--cookie`/env/stdin). Режимы `--check` / `--inspect` (дамп DOM+скриншот+API)
/ `--run` (отвязка: сначала API `/v1/xbox(-live)/disconnect`, потом клик в DOM, потом перепроверка).
Браузер chrome (проверен) | edge. Эндпоинты Xbox community-документированы и НЕ подтверждены на 2026 —
гонять `--inspect` на живом аккаунте и сверять, что реально срабатывает.

## Движок входа покупателя: `automation/buyer_login.py` (РАБОТАЕТ)
Headless-браузер не годится для входа (Arkose/PoW детектят автоматизацию — вход не проходит).
Поэтому движок логинится в **видимом** окне (на воркере это норм): вводит логин/пароль, а **PoW и
прозрачную капчу браузер решает САМ** — проверено вживую на @levkaster: `ok:true`, `.ROBLOSECURITY`
получена без участия человека. Перехват (`capture_login_net.py`) подтвердил вызовы
`apis.roblox.com/proof-of-work-service/v1/pow-puzzle` + `challenge/v1/continue` + прозрачный Arkose.
Выход — JSON: `{ok,account,roblosecurity}` | `{needs:'2fa',mediaType}` | `{needs:'captcha'}` | error.
Чистый HTTP-логин (robloxAuthClient) упирается в PoW (session-bound `pow-puzzle`, вслепую не собрать) —
поэтому вход переносим на браузерный движок.

ДАЛЬШЕ (не сделано): связать движок с заказами — воркер берёт заказ с логином/паролем → `buyer_login.py`
→ cookie → finalize → ready. Для **интерактивной** капчи/2FA нужен ПЕРСИСТЕНТНЫЙ браузер (держать
сессию между «нужна капча» и приходом токена от покупателя через hosted-страницу `/roblox/captcha/:token`).

## Суть метода (как у swizzyer.com)
Доставка Robux покупателю = покупка Robux **в приложении Roblox из Microsoft Store**, оплаченная
**балансом Microsoft-аккаунта** (от подарочных карт). Robux зачисляются на тот Roblox-аккаунт,
который **залогинен в приложении** → значит для выдачи покупателю надо логиниться в **его** аккаунт.
swizzyer — это B2B-инструмент для реселлеров (плата от $10), не прямой магазин.

## Что ТОЧНО установлено (доказано экспериментами)
1. **HTTP-воспроизведение покупки невозможно.** Два перехвата трафика (mitmproxy) показали: веб-часть
   Roblox видна (`www.roblox.com/premium/windows/robux`, `apis.roblox.com/payments-gateway/*`,
   Microsoft Store ID = `collections.mp.microsoft.com/v7.0/beneficiaries/me/keys`), но **сам платёж —
   нативное окно Windows Store** (`StoreContext.RequestPurchaseAsync`). Под любым системным прокси
   нативный шаг ломается (белый экран). HTTP-эндпоинта «списать баланс» НЕТ.
2. **Весь флоу автоматизируем через UI Automation** (не по пикселям — по именам элементов). Запись
   реальной покупки (`automation/record-purchase.py`) показала именованные элементы. Ручная покупка
   на этой машине **прошла успешно** (MS-аккаунт с балансом ~$299; после тестов ~$298).
3. swizzyer публичный API (`2faroblox.com/v1/openapi.json`) = только заказы + верификация входа +
   вебхуки (подтверждает нашу Фазу 1). Механизм покупки у них в закрытом бэкенде — тот же UWP-путь.

## Селекторы UIA (из записи) — основа автоматизации
- Окно приложения: `WindowControl Name='Roblox' ClassName='WINDOWSCLIENT'`. Внутри — `WEBVIEW2BROWSERAPP`.
  **WebView2-доступность ЛЕНИВАЯ**: дерево веб-контента пустое, пока в него не «ткнуть»
  `auto.ControlFromPoint(x,y)` (в записи это делали клики). Поэтому в `buy_robux.py` есть «прогрев».
- Страница Buy Robux: `DocumentControl Name='Buy Robux' autoId='RootWebArea'`. Паки — кнопки с ценой
  `ButtonControl Name='0,99 $' / '4,99 $' / '9,99 $' / '19,99 $'`; рядом слева сумма
  `TextControl '80' / '500' / '1 000' / '2 000'` (матчим по ближайшей строке).
- Нативное окно оплаты: `WindowControl Name='Узел для покупок в Store' ClassName='Windows.UI.Core.CoreWindow'`
  (внутри `ApplicationFrameWindow`). Оплата: `ButtonControl Name начинается с 'Баланс учетной записи Microsoft'`.
  Подтверждение: `ButtonControl Name='Купить'`.
- Успех: `TextControl Name='Покупка завершена.'` + `ButtonControl Name='Понятно' autoId='gotItButton'`.

## Что РАБОТАЕТ сейчас (`automation/buy_robux.py`)
- `python buy_robux.py --find` — находит 4 пака с верными ценами (после фикса привязки по ближайшей строке).
- `python buy_robux.py --select 80` — кликает пак, открывает окно оплаты, проверяет MS-баланс, находит
  «Купить», НЕ нажимает. **Проверено — работает.**
- `python buy_robux.py --buy 80` — полный цикл (реальная покупка). Доходит до окна; **тайминг**: окно
  оплаты иногда появляется не сразу — увеличил ожидание до 3 c + поиск окна до 60 c. Финальный прогон
  `--buy` до конца ещё НЕ подтверждён (прервали перед боевым тестом) — это первый шаг новой сессии.

Прочие инструменты автоматизации:
- `automation/record-purchase.py` — рекордер (клики+скриншоты+UIA-дерево+таймлайн). Папка `recording/` в .gitignore.
- `automation/inspect-ui.py` — разовый дамп UIA-дерева окна.

## Ближайшие шаги (приоритет)
1. **Добить `--buy 80`** на этой машине (подтвердить полный цикл: Купить → «Покупка завершена» → Понятно,
   и что Robux зачислились — проверить через `economy.roblox.com/v1/users/{id}/currency`).
2. **Скриптовать НАВИГАЦИЮ** к экрану Buy Robux из приложения (сейчас тестим с уже открытой страницы).
   Шаги до 24 в записи — это открытие магазина/Robux в приложении. Нужно автоматизировать (UIA/клик
   по иконке Robux). Возможен deep link `https://www.roblox.com/upgrades/robux` внутри приложения.
3. **Логин в аккаунт ПОКУПАТЕЛЯ** перед покупкой (иначе Robux уйдут не туда). В Phase-1 уже есть
   `robloxAuthClient.js` (login+2FA+hosted-страница) — но Robux-приложение логинится своим UI; надо
   либо автоматизировать логин в приложении, либо вход даёт `.ROBLOSECURITY`, а приложение умеет
   принимать сессию (проверить). Это ключевой архитектурный вопрос выдачи.
4. **Интеграция в воркер** (`worker.py` → реальные `purchase_robux()`/`claim_robux()` вызывают
   UIA-драйвер): poll заказа → логин покупателя → навигация → `buy_robux(amount)` → verify баланса → report.
5. **Расширить верификацию входа** по модели swizzyer (`NextAction`: wait/choose_one/choose_many=капча/
   provide_input=2FA/push_approval/credentials_retry) — Фаза 1, `robloxAuthClient.js` + hosted-страница.
6. **Инфра-предпосылки (вне кода):** MS-аккаунты в незаблокированном регионе с балансом (российские MS
   режут — `App-PurchaseRejected`), резидентные прокси (cookie .ROBLOSECURITY сбрасывается при смене IP),
   возможно солвер капчи для логинов.

## Риски (помнить)
Чарджбек → Roblox списывает Robux в минус и банит аккаунт покупателя; баны MS-аккаунтов за карты;
регион-локи; ToS Roblox (вход в чужие аккаунты, Robux вне платформы). Это эксплуатационное/юридическое
решение, не только техническое.

## Где что в репозитории
- Phase-1 оркестратор: `backend/src/{db,features/roblox,http/dispatchRoblox.js,integrations/roblox}`,
  фронт `frontend/src/features/roblox/RobloxTab.jsx`. Воркер-протокол: `/roblox/worker/{poll,report}`.
- Phase-2 автоматизация: `worker/msstore-worker/automation/` (этот каталог).
- Перехват трафика (Шаг 0, уже не нужен — путь доказан): `worker/msstore-worker/capture/`.
- Подробная история — в авто-памяти проекта (`memory/roblox-donation-autodelivery.md`), но она ЛОКАЛЬНА
  на машине; на другой машине ориентируйся на этот файл.
