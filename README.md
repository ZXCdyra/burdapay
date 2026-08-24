# PayFlow — процессинг платежей для high-risk мерчантов

Production-ready платёжная платформа: приём депозитов и выплаты через трейдеров.
Методы: **CARD** (Visa / Mastercard / МИР) и **СБП**.

## Стек

| Слой | Технологии |
|---|---|
| Backend | Node.js 20, TypeScript strict, NestJS 10 |
| БД | PostgreSQL 16 + Prisma ORM 5 |
| Очереди | Redis 7 + BullMQ (истечение ордеров, ретраи вебхуков) |
| Realtime | Socket.IO (push-события ордеров) |
| Auth | JWT (кабинеты) + API Key pk_/sk_ + HMAC-SHA256 (машины) |
| Валидация | Zod (env + DTO), глобальный ExceptionFilter |
| Документация | Swagger UI на `/docs` |
| Деплой | Docker multi-stage, docker-compose, Render Blueprint |

## Архитектура

```
Мерчант ──HMAC──▶ POST /orders ──▶ OrdersService (state machine)
                                      │  antifraud (velocity, blacklist)
                                      │  smart routing (score = 0.6*successRate + 0.25*(1-load) + 0.15*random)
                                      ▼
                              Trader (WS push) ──accept/confirm/mark-paid──▶ LedgerEntry (двойная запись)
                                      │                                        │
                                      ▼                                        ▼
                          order-expiry queue (TTL 15м)              Merchant balance / webhook HMAC → retry x5 backoff
```

### ER-диаграмма

```
Merchant 1──* ApiKey          Merchant 1──* Order *──1 Trader
Merchant 1──* LedgerEntry     Trader   1──* TraderRequisite        AdminUser (аудит)
Order    1──* OrderEvent       Order    1──* WebhookDelivery
FraudEvent                   BlacklistEntry
```

Ключевые поля `Order`: `type` DEPOSIT/WITHDRAWAL, `method` CARD/SBP,
`status`: PENDING → ASSIGNED → COMPLETED | CANCELLED | EXPIRED (+ FAILED/DISPUTED),
`merchantId+idempotencyKey` UNIQUE, `rerouteCount <= 2`, суммы в копейках (Decimal(18,2)).

### Движение денег

- **DEPOSIT COMPLETED**: merchant += amount−feeMerchant; trader −= amount−feeTrader; platform fee = feeMerchant+feeTrader.
- **WITHDRAWAL**: merchant −= amount+feeMerchant при создании (refund при отмене/истечении); trader += amount−feeTrader при выплате.
- Все списания — условные (`updateMany balance >= amount`) внутри Serializable-транзакции: уйти в минус нельзя.

## Структура проекта

```
payflow/
├── prisma/            schema.prisma, seed.ts (демо-аккаунты)
├── public/            Кабинеты (тёмная тема): index.html (логин),
│                      admin.html, merchant.html, trader.html, style.css, app.js
├── src/
│   ├── common/        config (zod env, AppConfig), guards (Jwt/Roles/ApiKey),
│   │                  utils (AES-256-GCM, HMAC), filters, interceptors, decorators
│   ├── prisma/ redis/ queues/ websocket/
│   ├── auth/          login, register merchant/trader, /auth/me
│   ├── orders/        сервис state machine (~800 строк), merchant API (x-api-key),
│   │                  trader actions, zod DTO
│   ├── routing/       смарт-роутинг с атомарным lock/unlock
│   ├── webhooks/      подписанные HMAC delivery с BullMQ-ретраями
│   ├── antifraud/     blacklist + velocity checks
│   ├── merchants/ traders/ admin/ payment-methods/ health/
│   └── main.ts        helmet, CORS, Swagger /docs, static public/
├── Dockerfile         node:20-alpine multi-stage, migrate on start
└── docker-compose.yml postgres + redis + migrate job + api
```

## Локальный запуск

```powershell
cd payflow
copy .env.example .env
docker compose up -d postgres redis
npm install
npx prisma migrate dev --name init
npm run seed          # напечатает демо-логины и sk_ ключ мерчанта
npm run start:dev
```

Открыть http://localhost:3000 → логин одним из демо-аккаунтов:

| Роль | Email | Пароль |
|---|---|---|
| ADMIN | admin@payflow.io | ChangeMe_Admin123 |
| MERCHANT | merchant@demo-casino.io | ChangeMe_Merchant123 |
| TRADER | trader1@demo.io | ChangeMe_Trader123 |

## Примеры curl

Логин:
```bash
curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"merchant@demo-casino.io","password":"ChangeMe_Merchant123"}'
```

Создание ордера машиной (подпись `t=<unix>,v1=hmac_sha256(sk, "<t>.<rawBody>")`):
```bash
BODY='{"type":"DEPOSIT","method":"CARD","amount":5000,"idempotencyKey":"ord-001"}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SK" -hex | cut -d' ' -f2)

curl -s -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' -H "x-api-key: $PK" \
  -H "x-signature: t=$T,v1=$SIG" -d "$BODY"
```

Трейдер принимает ордер (JWT из логина):
```bash
curl -X POST localhost:3000/trader/orders/<id>/accept -H "Authorization: Bearer $JWT"
```

## Деплой на Render

1. Запушьте репозиторий на GitHub.
2. Render Dashboard → **New → Postgres** (план basic-256mb). После создания скопируйте
   **Internal Database URL** → это `DATABASE_URL`.
3. **New → Key Value** (Redis). Скопируйте Internal URL → `REDIS_URL`
   (формат `redis://red-xxxx:6379`).
4. **New → Web Service**, подключите репозиторий:
   - Runtime: **Docker** (Render соберёт Dockerfile сам)
   - Plan: Starter
   - Health Check Path: `/health`
5. Environment variables Web Service:

   | Переменная | Значение |
   |---|---|
   | NODE_ENV | production |
   | DATABASE_URL | Internal Database URL из п.2 |
   | REDIS_URL | Internal URL из п.3 |
   | JWT_SECRET | `openssl rand -hex 32` |
   | APP_ENCRYPTION_KEY | `openssl rand -hex 32` |
   | CARD_HASH_PEPPER | `openssl rand -hex 16` |
   | WEBHOOK_ATTEMPTS | 5 |
   | DEFAULT_ORDER_TTL_SECONDS | 900 |

   Остальные переменные имеют безопасные дефолты (.env.example).

6. Первый деплой: команда старта контейнера сама выполнит
   `npx prisma migrate deploy && node dist/main.js`. Миграции лежат в
   `prisma/migrations` — закоммитьте их после локального `migrate dev`.
7. Сидинг продакшена: Render → новый **Job** (или Shell веб-сервиса):
   `npx prisma db seed`. Он выведет пароли админа и sk_-ключ первого мерчанта —
   сохраните сразу, секрет больше не показывается.
8. Проверка: `https://<service>.onrender.com/health`, `/docs`, `/` (логин кабинетов).
9. BullMQ-воркеры живут в том же процессе — масштабируйте вертикально или
   включите несколько инстансов (очереди уже конкурентобезопасны).

## Безопасность

- Пароли bcrypt(12); JWT HS256 TTL 12h; RBAC guard на кабинетах.
- API-секреты только AES-256-GCM; номер карты хешируется sha256(pepper) для антифрода,
  полный номер не возвращается никому (только last4).
- HMAC-подпись машинных запросов с окном ±300с против replay.
- Helmet, CORS whitelist, rate-limit (Throttler), глобальный Zod-парсинг env.
