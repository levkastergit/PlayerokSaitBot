# Roblox MS Store worker (метод свизера)

Windows-воркер автовыдачи Robux методом «Microsoft Store»: покупка Robux в приложении
Roblox из Microsoft Store за баланс Microsoft-аккаунта и зачисление на аккаунт покупателя.

Это **Часть 2** архитектуры (см. главный план). Бэкенд (Node, в Docker) — это оркестратор:
он держит очередь заказов, вход покупателя (hosted 2FA) и инвентарь MS-аккаунтов. Воркер
запускается **на отдельной Windows-машине/VM** с установленным приложением Roblox из
Microsoft Store и забирает заказы из очереди.

> ⚠️ Шаги покупки (`phase_ms_buy`) и зачисления (`phase_claim`) в этой Фазе — заглушки с TODO.
> Они требуют либо UI-автоматизации приложения, либо снятых «живых» эндпоинтов (см. ниже).
> По умолчанию воркер честно помечает такой заказ `failed`, а не имитирует успех.
> Шаг `phase_verify` (проверка баланса покупателя) — настоящий.

## Почему это не чистый HTTP

Оплату балансом Microsoft проводит UWP-вызов `Windows.Services.Store.StoreContext.RequestPurchaseAsync`
**внутри приложения**, на UI-потоке Windows. Публичного серверного HTTP-эндпоинта, который
списывает баланс MS-аккаунта за платный товар, нет (документированный S2S-`grant` отдаёт только
бесплатные товары). Поэтому шаг оплаты делается на реальной Windows-машине.

На стороне Roblox эндпоинт зачисления Windows/Xbox-покупки **не опубликован** (документированы
только `/v1/apple/purchase` и `/v1/google/purchase`). Его нужно **снять** с живого клиента.

## Снятие эндпоинтов (разблокирует Фазу 2)

Цель — записать реальные сетевые запросы при ручной покупке Robux за баланс MS, чтобы понять,
что именно вызывает приложение Roblox для зачисления.

1. На тестовой Windows-машине поставьте **mitmproxy** (или Fiddler) и доверьте его корневой
   сертификат системе (UWP-приложения уважают системный store; для UWP может потребоваться
   `CheckNetIsolation LoopbackExempt -a -n=<пакет Roblox>`).
2. Войдите в приложение Roblox (Microsoft Store) под тестовым аккаунтом Roblox; в Microsoft
   Store войдите под MS-аккаунтом с балансом.
3. Включите перехват и купите минимальный пак Robux, оплатив **«Microsoft account balance»**.
4. В записи найдите вызовы к:
   - `*.microsoft.com` / `purchase.mp.microsoft.com` / `licensing*.xboxlive.com` — оплата;
   - `collections.mp.microsoft.com/v*/collections/{query,consume}` — «Generate Store ID» / consume;
   - `billing.roblox.com` или `apis.roblox.com/payments|purchasing` — зачисление на аккаунт Roblox
     (ищите `windows`/`xbox`/`microsoft` в пути, тело с receipt/StoreId/productId).
5. Зафиксируйте метод, путь, заголовки (включая `X-CSRF-TOKEN`, `.ROBLOSECURITY`), тело и ответ.
   Передайте это — реализуем `purchase_robux()` / `claim_robux()` в [worker.py](worker.py).

Если воспроизвести покупку запросами вне приложения не выйдет (привязка к устройству/нонсу),
Фаза 2 пойдёт по пути **UI-автоматизации** приложения (pywinauto / FlaUI / WinAppDriver).

## Запуск

Требуется Python 3.9+. Воркер использует только стандартную библиотеку.

```powershell
$env:ROBLOX_WORKER_BACKEND = "https://playerokbot.com"   # адрес бэкенда
$env:ROBLOX_WORKER_TOKEN   = "<тот же секрет, что на бэкенде>"
$env:ROBLOX_WORKER_ID      = "win-01"
python worker.py
```

На бэкенде (его `.env`) задайте тот же секрет и публичный адрес для hosted-2FA ссылок:

```
ROBLOX_WORKER_TOKEN=<длинный-случайный-секрет>
PUBLIC_BASE_URL=https://playerokbot.com
```

(Опционально, Фаза 3 — солвер капчи для входа покупателей:
`ROBLOX_CAPTCHA_PROVIDER`, `ROBLOX_CAPTCHA_API_KEY`, `ROBLOX_CAPTCHA_PROXY`.)

## Что нужно от вас (вне кода)

- Windows-машина(ы)/VM с приложением Roblox из Microsoft Store.
- **Регион-привязанные** Microsoft-аккаунты с балансом (Microsoft привязывает валюту к рынку
  аккаунта — VPN не обходит).
- Резидентные/мобильные прокси, привязанные по одному на аккаунт (cookie `.ROBLOSECURITY`
  сбрасывается при смене IP/региона).
- (Для входов с капчей) платный солвер FunCaptcha.

## Риски (важно)

Метод нарушает ToS Roblox и Microsoft и несёт реальные риски: чарджбек/возврат → Roblox
списывает Robux в минус и **банит аккаунт покупателя**; баны MS-аккаунтов за частые карты;
регион-локи; бан Roblox за «Robux вне платформы» и вход в чужие аккаунты. Это эксплуатационное
и юридическое решение, а не только техническое.
