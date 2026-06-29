# Partner Redemption API — Card Mode

Recommended Base URL: `https://rootchatgptplus.com/api/partner/v1`

Legacy Base URL, if already integrated: `https://admin.rootchatgptplus.com/api/partner/v1`

This API redeems one previously purchased card for one target account. The card determines the product tier. The caller cannot select or override the product tier.

Supported card products include:

- ChatGPT Plus: `plus`
- ChatGPT Pro 5X: `pro5x`
- ChatGPT Pro 20X: `pro20x`
- ChatGPT Plus Yearly: `plusyear`
- Claude Pro: `claude_pro`

All requests and responses use JSON over HTTPS. Never send the API key in a URL.

---

## 1. Authentication

Send the API key in every request:

```http
Authorization: Bearer YOUR_API_KEY
```

Rules:

- API keys are client-specific secrets.
- Store the API key only on your server.
- Do not expose the API key in browser frontend, mobile app frontend, logs, or URLs.
- Requests may be restricted to IP addresses agreed with the seller.

---

## 2. Idempotency

Every create-redemption request must include an idempotency key:

```http
Idempotency-Key: your-unique-order-id-0001
```

Rules:

- The same intended redemption must always reuse the same `Idempotency-Key`.
- Retrying the same request with the same key returns the original order and does not create a second activation.
- Reusing the same key with different `card_code`, `account_id`, or `organization_id` returns HTTP `409`.
- Recommended format: `YOUR_SYSTEM_ORDER_ID` or `KM12-20260629-000001`.
- Allowed characters: letters, numbers, `.`, `_`, `:`, `-`.
- Length: 8 to 128 characters.

---

## 3. Create a redemption

```http
POST /redemptions
Authorization: Bearer YOUR_API_KEY
Idempotency-Key: your-unique-order-id-0001
Content-Type: application/json
```

Full URL:

```text
https://rootchatgptplus.com/api/partner/v1/redemptions
```

There are two target formats, depending on the card product.

---

## 4. ChatGPT card redemption

Use this format for ChatGPT products:

- `plus`
- `pro5x`
- `pro20x`
- `plusyear`

### Request body

```json
{
  "card_code": "ABCD-EFGH-IJKL-MNOP",
  "account_id": "6d818905-141d-4928-8290-f1aed3ee4df0",
  "confirm_overwrite": true
}
```

### Field description

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `card_code` | string | yes | Purchased card code. |
| `account_id` | string | yes | ChatGPT Account ID, canonical UUID format. |
| `confirm_overwrite` | boolean | yes | Must be `true`. Activation may replace existing membership time. |

### Notes

- ChatGPT cards require `account_id`.
- Do not send `organization_id` for ChatGPT cards.
- Do not send username or password.
- Do not send Session JSON to this partner API.

---

## 5. Claude Pro card redemption

Use this format for Claude Pro cards.

### Request body

```json
{
  "card_code": "ABCD-EFGH-IJKL-MNOP",
  "organization_id": "12345678-1234-1234-1234-123456789abc",
  "confirm_overwrite": true
}
```

### Field description

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `card_code` | string | yes | Purchased Claude Pro card code. |
| `organization_id` | string | yes | Claude Organization ID, canonical UUID format. |
| `confirm_overwrite` | boolean | yes | Must be `true`. Activation may replace existing membership time. |

### Claude Organization ID

The customer should get the Claude Organization ID from Claude account settings:

```text
https://claude.ai/settings/account
```

The format is usually a UUID:

```text
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Notes

- Claude Pro cards require `organization_id`.
- Claude Pro does not need username or password.
- Claude Pro does not need `account_id`.
- Claude Pro does not need Session JSON.
- Claude Pro does not need SessionKey for normal redemption.
- SessionKey is only used for not-arrived redelivery/manual recovery, not for normal order creation.

---

## 6. Successful submission response

Successful submission returns HTTP `202`.

```json
{
  "code": 0,
  "message": "Redemption accepted.",
  "data": {
    "order_no": "R20260622000000...",
    "status": "pending",
    "product_code": "claude_pro",
    "account_id": "12345678-1234-1234-1234-123456789abc",
    "created_at": "2026-06-22T00:00:00Z"
  }
}
```

Response fields:

| Field | Description |
| --- | --- |
| `order_no` | Seller-side order number. Save it for order query and support. |
| `status` | Current order status. See status table below. |
| `product_code` | Product tier determined by the card. |
| `account_id` | Target UUID. For Claude Pro, this value is the Claude Organization ID. |
| `created_at` | Order creation time. |
| `completed_at` | Returned when the order has completed. |

---

## 7. Query a redemption

```http
GET /redemptions/{order_no}
Authorization: Bearer YOUR_API_KEY
```

Full URL example:

```text
https://rootchatgptplus.com/api/partner/v1/redemptions/R20260622000000...
```

### Response example

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "order_no": "R20260622000000...",
    "status": "succeeded",
    "product_code": "claude_pro",
    "account_id": "12345678-1234-1234-1234-123456789abc",
    "created_at": "2026-06-22T00:00:00Z",
    "completed_at": "2026-06-22T00:01:10Z"
  }
}
```

---

## 8. Status values

| Status | Meaning | Recommended action |
| --- | --- | --- |
| `pending` | Order accepted and waiting. | Keep polling. |
| `processing` | Activation is in progress. | Keep polling. |
| `succeeded` | Activation succeeded. | Mark order as completed. |
| `failed` | Activation failed. | Stop automatic retry and contact support with `order_no`. |
| `review` | Result is uncertain or requires manual review. | Do not resubmit the card. Contact support with `order_no`. |

Recommended polling:

- Poll every 2-3 seconds during the first 90 seconds.
- If still not terminal after 90 seconds, poll less frequently or reconcile later.
- Do not submit the same card again with a new `Idempotency-Key`.

---

## 9. Error handling

| HTTP | `code` | Meaning |
| --- | ---: | --- |
| 400 | 40000 | Invalid request, target UUID, or idempotency key. |
| 401 | 40100 | Missing, invalid, or disabled API key. |
| 403 | 40300 | Source IP is not allowed. |
| 409 | 100102 | Card has already been used. |
| 409 | 40900 | Idempotency key conflict or request in progress. |
| 422 | 100101 | Invalid card. |
| 422 | 100103 | Expired card. |
| 429 | 42900 | Rate limit exceeded. |
| 503 | 100501 | Product is temporarily out of stock. |

Use both HTTP status and JSON `code`. The optional `trace_id` should be included in support requests.

---

## 10. Common error response examples

### Missing or invalid API key

```json
{
  "code": 40100,
  "message": "Missing or invalid API key."
}
```

### Invalid Idempotency-Key

```json
{
  "code": 40000,
  "message": "Idempotency-Key must be 8-128 characters using letters, numbers, '.', '_', ':', or '-'."
}
```

### Invalid Account ID or Organization ID

```json
{
  "code": 40000,
  "message": "account_id / organization_id must be a canonical UUID."
}
```

### Idempotency conflict

```json
{
  "code": 40900,
  "message": "This Idempotency-Key was already used with a different request."
}
```

---

## 11. cURL examples

### ChatGPT card

```bash
curl -X POST "https://rootchatgptplus.com/api/partner/v1/redemptions" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-0001" \
  -d '{
    "card_code": "ABCD-EFGH-IJKL-MNOP",
    "account_id": "6d818905-141d-4928-8290-f1aed3ee4df0",
    "confirm_overwrite": true
  }'
```

### Claude Pro card

```bash
curl -X POST "https://rootchatgptplus.com/api/partner/v1/redemptions" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-0002" \
  -d '{
    "card_code": "ABCD-EFGH-IJKL-MNOP",
    "organization_id": "12345678-1234-1234-1234-123456789abc",
    "confirm_overwrite": true
  }'
```

### Query order

```bash
curl -X GET "https://rootchatgptplus.com/api/partner/v1/redemptions/R20260622000000..." \
  -H "Authorization: Bearer YOUR_API_KEY"
```

---

## 12. JavaScript example

```js
const BASE_URL = "https://rootchatgptplus.com/api/partner/v1";
const API_KEY = "YOUR_API_KEY";

async function redeemClaudeProCard() {
  const response = await fetch(`${BASE_URL}/redemptions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "order-0002"
    },
    body: JSON.stringify({
      card_code: "ABCD-EFGH-IJKL-MNOP",
      organization_id: "12345678-1234-1234-1234-123456789abc",
      confirm_overwrite: true
    })
  });

  return await response.json();
}

async function queryRedemption(orderNo) {
  const response = await fetch(`${BASE_URL}/redemptions/${orderNo}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${API_KEY}`
    }
  });

  return await response.json();
}
```

---

## 13. Python example

```python
import requests

BASE_URL = "https://rootchatgptplus.com/api/partner/v1"
API_KEY = "YOUR_API_KEY"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
    "Idempotency-Key": "order-0002",
}

payload = {
    "card_code": "ABCD-EFGH-IJKL-MNOP",
    "organization_id": "12345678-1234-1234-1234-123456789abc",
    "confirm_overwrite": True,
}

resp = requests.post(f"{BASE_URL}/redemptions", headers=headers, json=payload, timeout=30)
print(resp.status_code)
print(resp.json())
```

Query order:

```python
import requests

BASE_URL = "https://rootchatgptplus.com/api/partner/v1"
API_KEY = "YOUR_API_KEY"

order_no = "R20260622000000..."
resp = requests.get(
    f"{BASE_URL}/redemptions/{order_no}",
    headers={"Authorization": f"Bearer {API_KEY}"},
    timeout=30,
)
print(resp.status_code)
print(resp.json())
```

---

## 14. Integration checklist

1. Store `YOUR_API_KEY` only on the server.
2. Generate one unique `Idempotency-Key` for each intended redemption.
3. For ChatGPT cards, submit `account_id`.
4. For Claude Pro cards, submit `organization_id`.
5. Always set `confirm_overwrite` to `true`.
6. Save the returned `order_no`.
7. Poll `GET /redemptions/{order_no}` until terminal status.
8. Treat `succeeded` as completed.
9. Treat `failed` and `review` as manual handling states.
10. Never resubmit the same card with a new idempotency key unless support explicitly instructs you to do so.
