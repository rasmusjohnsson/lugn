# Lugn push server

En liten Express-server som tar emot push-prenumerationer från Lugn-appen och levererar schemalagda notiser via Web Push — så att de når telefonen även när appen är stängd.

- **Storlek**: ~150 rader Node.js
- **Beroenden**: `express`, `cors`, `web-push` (alla rena JS, inga native moduler)
- **Lagring**: in-memory som standard. Sätt `LUGN_DATA_DIR` för att spara till JSON-fil mellan skrivningar.
- **VAPID-nycklar**: läses från env vars om satta, annars från fil eller genereras + loggas vid uppstart.

## Köra lokalt

```bash
cd server
npm install
npm start
```

Servern lyssnar på `http://localhost:3030`. I appens Inställningar → Push-server URL: `http://localhost:3030`. Funkar bara om frontend och backend körs på samma maskin (annars HTTPS-krav).

## Driftsätta gratis (Render.com)

1. Skapa konto på [render.com](https://render.com).
2. **New → Web Service** → koppla till ditt GitHub-repo (forkat från detta).
3. Inställningar:
   - **Root directory**: `server`
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Plan**: Free
4. **Environment variables** (alla valfria):
   - `LUGN_VAPID_SUBJECT`: t.ex. `mailto:du@exempel.se`
   - `LUGN_ALLOWED_ORIGINS`: t.ex. `https://dittnamn.github.io` (komma-separerad lista; default `*`)
5. **Persistent disk** (valfritt — kräver betald plan): skapa en disk monterad på `/var/data` och sätt env `LUGN_DATA_DIR=/var/data`. På Free-tier hoppar du detta steg och sätter istället `LUGN_VAPID_PUBLIC_KEY` + `LUGN_VAPID_PRIVATE_KEY` (kopiera från första bygget) så nycklarna är stabila. Klienten ombeds automatiskt om servern tappar prenumerationer.
6. Klicka **Create Web Service**. Efter någon minut har du en URL som `https://lugn-push-xyz.onrender.com`.
7. I Lugn-appen: klistra in URL:en, aktivera Bakgrundsnotiser, bevilja notistillstånd.

> **Notera**: Render Free-planen sover efter 15 min inaktivitet. Notiser fungerar ändå eftersom servern vaknar när webbläsaren pingar `/schedule`, men en notis kan försenas några sekunder. För 24/7-tillförlitlighet — uppgradera till Starter eller använd Fly.io / Railway.

## Driftsätta på Fly.io

1. Installera `flyctl`, kör `fly auth login`.
2. I `server/`-mappen: `fly launch` (välj inget databas-tillägg), välj region.
3. `fly volumes create data --size 1`
4. Lägg till i `fly.toml`:
   ```toml
   [mounts]
   source = "data"
   destination = "/data"
   ```
5. `fly secrets set LUGN_DATA_DIR=/data LUGN_VAPID_SUBJECT=mailto:du@exempel.se`
6. `fly deploy`

## API

| Endpoint | Beskrivning |
|---|---|
| `GET /health` | Returnerar `{ ok: true }`. |
| `GET /vapid-public-key` | Returnerar publik VAPID-nyckel. |
| `POST /subscribe` | Body: `{ subscription, userAgent }`. Returnerar `{ subscriptionId }`. Idempotent — samma endpoint återanvänds. |
| `POST /schedule` | Body: `{ subscriptionId, items: [{ tag, title, body, sendAt }] }`. Ersätter alla väntande pushar för prenumerationen. `sendAt` = millisekunder sedan epoch. |
| `DELETE /subscribe/:id` | Tar bort prenumeration och alla schemalagda pushar. |

Schemaläggningen körs internt: var 30:e sekund hämtar servern alla pushar med `send_at <= now()`, skickar dem via `web-push` med 1 timmes TTL, och markerar som skickade. Prenumerationer som returnerar 404/410 städas bort.

## Säkerhet

- Endast notisrubriker och body lagras (inte hela aktiviteten).
- Datat skickas över HTTPS via webbläsarens push-tjänst (Mozilla / Google / Apple beroende på enhet).
- För striktare integritet, sätt `LUGN_ALLOWED_ORIGINS` till exakt din apps URL.
- Detta är **inte** ett multi-tenant-SaaS — varje användare bör driva sin egen push-server, eller köra en med begränsad CORS för bara sin egen app.

## Licens

MIT.
