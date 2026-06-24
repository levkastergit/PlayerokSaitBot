# Robux delivery via MS Store — прогресс

> Редактированный снимок состояния (без кредов/куки/IP — секреты живут в env/локальных файлах, см. `.gitignore`).
> Дата: 2026-06-24.

## Цель
Автоматизированная выдача Robux через MS-Store-баланс: один funded-MSA-плательщик заряжает Robux на аккаунт **покупателя** (получатель определяется Roblox-сессией в WebView, а не полем Microsoft). Модель — как у swizzyer/romplhub: малый пул funded-Windows-нод, единица переиспользования = cookie покупателя, не машина.

## Фазы

| Фаза | Статус | Суть |
|---|---|---|
| P1. Разбор механизма покупки | ✅ done | Полная charge-цепочка снята live (mitmproxy): `createOrder → buynow → updateCart → PaymentSessionDescriptions → Cart/purchase`. Вся цепочка на ОДНОМ XSTS (`Authorization: XBL3.0`). |
| P2. Получатель (recipient binding) | ✅ done | Доказано: получатель = `.ROBLOSECURITY`-сессия в WebView приложения. НЕ publisherUserId, НЕ keys, НЕ serviceTicket (все опровергнуты тестами). |
| P3. keys/serviceTicket | ✅ done | `beneficiaries/me/keys` — side-channel, **скипается** (фейковый 200 достаточно). serviceTicket в самой charge-цепочке не используется. |
| P4. Минт платёжного токена | ✅ done | XSTS плательщика минтится headless из email+password (`mint_pay_token.py`): `login.live.com → RPS → user.auth → XSTS → createOrder=200`. Payer-сторона масштабируется. |
| P5. Инжект куки покупателя | ✅ done | Доказано end-to-end (split-кейс): нативно залогинен аккаунт-1, в WebView2 приложения через CDP впрыснута кука аккаунта-2 → **Robux ушли аккаунту-2**. Получатель переключается инжектом. |
| P6. Headless-charge (без приложения) | ❌ closed | Исчерпывающе доказано: **невозможно**. См. ниже. |
| P7. B2 — авто-выдача на реальной ноде | 🟡 in progress | Запуск приложения + инжект куки + авто-подтверждение нативного окна оплаты. Осталась локаль-независимая кнопка «Купить». |

## P6: почему headless закрыт (исчерпывающе)
MS-charge **требует живую in-context Saturn-сессию в браузере приложения**. Проверено со всех сторон, все упёрлись в стену:

- **buynow App-Authentication**: standalone-Chromium → `App-AuthenticationTokenInvalid`, а чистый urllib с ТЕМ ЖЕ токеном в ту же секунду → 200+283КБ Saturn. buynow различает источник (browser vs clean-HTTP) и валидирует identity вызывающего приложения, которой у standalone-браузера нет.
- **Корзина 423 Locked**: updateCart отдаёт 423 даже со всеми реальными значениями (piid, accountId, addrId, paymentSessionId), родным `cartMuid`+`vector-id`+куками из браузера, и с общим **ms-cv-base** (сессионная корреляция как в захвате). 423 = серверный анти-фрод-замок, требующий живую device-fingerprint-сессию (fpt/df.cfp рождаются JS в реальном checkout).
- **Веб-страница `/premium/windows/robux`**: MS-баланс доступен только в ветке `isPcGdkApp` (нативное приложение). В обычном браузере клик по паку замирает на `check-user-purchase-settings` (натив-делегация). Веб-путь умеет только Stripe/Credit — отвергнут (Credit≈гифткарты, запрещено).

**Вывод P6**: headless-браузерного шортката для MS-баланса НЕТ. Это by-design анти-автоматизация Microsoft, не пропущенный шаг.

## Среда: VM vs реальная машина
| Среда | RobloxPlayerBeta | Charge |
|---|---|---|
| Dev-VM (oVirt/KVM, без GPU) | падает/не стартует (Hyperion анти-VM) | ❌ невозможен |
| Реальная Windows-машина | работает | ✅ (charge проходит, проверено) |

Проба «частичного запуска» на VM: выживает только лаунчер `GameLaunchHelper` (коммерцию не трогает), а purchase-WebView с App-Auth живёт в `RobloxPlayerBeta`, который на VM не стартует. ⇒ **B2 гнать только с реального железа.** VM годна для разработки/тестов кода и минта токенов, не для финального charge.

## Инструменты (в этой папке `automation/`)
- `mint_pay_token.py` — минт XSTS плательщика из email+password (createOrder-canary).
- `buyer_login.py` — headless-логин покупателя → `.ROBLOSECURITY` (получатель).
- `b2_full_test.py` — оркестратор B2: логин покупателя → запуск приложения → CDP-инжект куки → клик пака → подтверждение оплаты.
- `capture_msstore_app.py` / `run_msstore_capture.ps1` — mitmproxy-капчур charge-цепочки (с режимом `DROP_KEYS`).
- `headless_charge.py` / `headless_cart.py` / `buynow_dryrun.py` / `headless_probe.py` — артефакты P6-исследования (документируют стену; не рабочий путь).

## Следующий шаг
Добить `b2_full_test.py`: локаль-независимое авто-нажатие «Купить» в нативном окне Store (UIA по AutomationId/роли, не по тексту). После — рабочая выдача на реальной ноде: запуск с логином/паролем покупателя → Robux ему.
