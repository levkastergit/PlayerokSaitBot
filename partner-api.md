# Partner Redemption API

Base URL: `https://admin.rootchatgptplus.com/api/partner/v1`

This API redeems one previously purchased card for one ChatGPT AccountID. All
requests and responses use JSON over HTTPS. Never send the API key in a URL.

## Authentication

Send the API key in every request:

```http
Authorization: Bearer ogp_live_...
```

Keys are client-specific and must be stored as secrets. Requests may also be
restricted to IP addresses agreed with the seller.

## Create a redemption

```http
POST /redemptions
Authorization: Bearer ogp_live_...
Idempotency-Key: your-unique-order-id-0001
Content-Type: application/json
```

```json
{
  "card_code": "ABCD-EFGH-IJKL-MNOP",
  "account_id": "6d818905-141d-4928-8290-f1aed3ee4df0",
  "confirm_overwrite": true
}
```

`Idempotency-Key` must be unique for each intended redemption. Retrying the
same request with the same key returns the original order and does not create a
second activation. Reusing it with different data returns HTTP `409`.

Successful submission returns HTTP `202`:

```json
{
  "code": 0,
  "message": "Redemption accepted.",
  "data": {
    "order_no": "R20260622000000...",
    "status": "pending",
    "product_code": "pro5x",
    "account_id": "6d818905-141d-4928-8290-f1aed3ee4df0",
    "created_at": "2026-06-22T00:00:00Z"
  }
}
```

The card determines the product. The caller cannot select or override the
product tier.

## Query a redemption

```http
GET /redemptions/{order_no}
Authorization: Bearer ogp_live_...
```

`status` is one of `pending`, `processing`, `succeeded`, or `failed`. Failed
orders also contain a stable `failure_code` and an English `failure_message`.
Poll every
2-3 seconds until a terminal status is returned. Stop after 90 seconds and
reconcile later instead of submitting the card with a new idempotency key.

## Error handling

| HTTP | `code` | Meaning |
| --- | ---: | --- |
| 400 | 40000 | Invalid request, AccountID, or idempotency key |
| 401 | 40100 | Missing, invalid, or disabled API key |
| 403 | 40300 | Source IP is not allowed |
| 409 | 100102 | Card has already been used |
| 409 | 40900 | Idempotency key conflict or request in progress |
| 422 | 100101 | Invalid card |
| 422 | 100103 | Expired card |
| 429 | 42900 | Rate limit exceeded |
| 503 | 100501 | Product is temporarily out of stock |

Use both HTTP status and `code`. The optional `trace_id` should be included in
support requests.
