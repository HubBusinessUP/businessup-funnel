# businessup-bot — Edge Function

Cervello del funnel Business UP: bot Telegram conversazionale (webhook mode) +
tracking funnel + follow-up automatico + CRM API per l'admin web.

- **Runtime:** Supabase Edge Functions (Deno)
- **Progetto Supabase:** `jwpbopkoscqooovfvwqn`
- **Schema DB:** `businessup`
- **Endpoint live:** `https://jwpbopkoscqooovfvwqn.supabase.co/functions/v1/businessup-bot`

> ⚠️ Questo file è stato **recuperato dalla versione deployata (v23)**: il sorgente
> non era in Git. I segreti, prima hardcoded, sono ora esternalizzati su variabili
> d'ambiente (vedi `.env.example`).

## Rotte principali (`/<sub>`)

| Sub | Auth | Uso |
|-----|------|-----|
| `telegram` | `x-telegram-bot-api-secret-token` = `WEBHOOK_SECRET` | webhook updates Telegram |
| `cron-followup` | `?key=CRON_SECRET` | follow-up automatico (pg_cron) |
| `track`, `catalogo`, `me`, `attiva`, `news`, `my-affiliate`, `affiliate-request`, `delete-me` | initData / pubbliche | Mini App |
| `stats`, `metrics`, `leads`, `broadcast`, `set-stage`, `servizi`, `pagamenti`, `fatturato`, `lead`, `nota`, `affiliate-*`, `news-*` | `x-admin-key` = `ADMIN_API_KEY` | CRM admin |

## Deploy

1. Imposta i segreti (una volta sola):
   ```bash
   supabase secrets set --project-ref jwpbopkoscqooovfvwqn \
     BOT_TOKEN=... ADMIN_ID=334179105 WEBHOOK_SECRET=... \
     ADMIN_API_KEY=... CRON_SECRET=...
   ```
   (oppure dal Dashboard → Edge Functions → Secrets)

2. Deploy:
   ```bash
   supabase functions deploy businessup-bot --project-ref jwpbopkoscqooovfvwqn --no-verify-jwt
   ```

3. Registra il webhook Telegram (una volta):
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d "url=https://jwpbopkoscqooovfvwqn.supabase.co/functions/v1/businessup-bot/telegram" \
     -d "secret_token=<WEBHOOK_SECRET>"
   ```

> Finché non rideployi, resta attiva la **v23 con i segreti vecchi hardcoded**:
> rideploya **solo dopo** aver impostato i secrets, altrimenti il bot va in errore
> (`Variabile d'ambiente mancante`).
