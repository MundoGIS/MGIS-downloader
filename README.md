
<!--
This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
Copyright (C) 2025 MundoGIS.
-->

# MGIS-Downloader

MGIS-Downloader är ett lokalhostat verktyg för att ladda ner och bearbeta geografiska data från svenska leverantörer.

> **OBS:** MGIS-Downloader är byggt uteslutande för den svenska marknaden. Applikationen hämtar data från svenska källor (Lantmäteriet, ArtData/GBIF Sverige) och stödjer inga andra länders datakällor eller koordinatsystem.

Funktioner
- ArtData (GBIF) — ladda ner artobservationer
- Lantmäteriets STAC API (vektor & höjd) — ladda ner vektor- och höjddata
- Interaktiv karta för att välja område
- Paketering (ZIP), efterbearbetning (merge, VRT, överviews) och generering av tile index

Krav
- **Node.js** 18 eller senare samt npm
- **GDAL** (inkl. `gdalbuildvrt`, `gdalinfo`, `gdal_translate`, `gdaladdo`, `gdal_merge.py`) — antingen fristående installerat eller via QGIS
- **Python 3** med GDAL-bindningar (används för att köra `gdal_merge.py`)
- **Git** (för att klona repot)
- Stödda operativsystem: **Windows**, **Linux** och **macOS**

Snabbstart (Windows)
1. Klona repo och installera beroenden:

```powershell
git clone https://github.com/MundoGIS/MGIS-Downloader.git
cd MGIS-Downloader
npm install
```

2. Installera QGIS (rekommenderas, innehåller GDAL och Python) eller GDAL fristående.

3. Skapa `.env` i projektroten:

```ini
GDAL="C:/QGIS/apps/gdal/"
QGIS="C:/QGIS/bin/"
PORT=3003
```

4. Starta servern:

```powershell
npm start
```

Snabbstart (Linux — Debian/Ubuntu)
1. Installera systemkrav:

```bash
sudo apt update
sudo apt install -y git nodejs npm gdal-bin python3-gdal
```

   (Kontrollera att Node.js-versionen är 18+: `node -v`. Om distributionens paket är för gammal, installera via [NodeSource](https://github.com/nodesource/distributions) eller [nvm](https://github.com/nvm-sh/nvm).)

2. Klona repo och installera beroenden:

```bash
git clone https://github.com/MundoGIS/MGIS-Downloader.git
cd MGIS-Downloader
npm install
```

3. Skapa `.env` i projektroten:

```ini
GDAL=""
QGIS=""
PYTHON_CMD=python3
GDAL_MERGE=/usr/bin/gdal_merge.py
PORT=3003
```

   (Kör `which gdal_merge.py` för att hitta rätt sökväg om den skiljer sig.)

4. Starta servern:

```bash
npm start
```

Snabbstart (macOS)
1. Installera systemkrav via [Homebrew](https://brew.sh):

```bash
brew install node gdal python3
```

2. Klona repo och installera beroenden:

```bash
git clone https://github.com/MundoGIS/MGIS-Downloader.git
cd MGIS-Downloader
npm install
```

3. Skapa `.env` i projektroten:

```ini
GDAL=""
QGIS=""
PYTHON_CMD=python3
GDAL_MERGE=/opt/homebrew/bin/gdal_merge.py
PORT=3003
```

   (Sökvägen kan variera mellan Intel-Mac `/usr/local/bin/...` och Apple Silicon `/opt/homebrew/bin/...`. Kör `which gdal_merge.py` för att verifiera.)

4. Starta servern:

```bash
npm start
```

Öppna webbläsaren på `http://localhost:3003` (oavsett operativsystem).

Köra som tjänst/bakgrundsprocess
- **Windows**: `npm run service:install` installerar appen som en Windows-tjänst (via `node-windows`). Avinstallera med `npm run service:uninstall`.
- **Linux**: `sudo ./scripts/install-linux-service.sh` installerar en systemd-tjänst (`mgis-downloader`) som startar automatiskt vid boot. Avinstallera med `sudo ./scripts/uninstall-linux-service.sh`. Alternativt kan valfri processhanterare (t.ex. `pm2`) användas.
- **macOS**: kör `npm start` direkt, eller använd `pm2`/`launchd` för att köra som bakgrundstjänst.

Säkerhet & drift bakom IIS (URL Rewrite / ARR)
MGIS-Downloader har ingen inloggning (autentisering sker bara mot Lantmäteriet/GBIF:s API:er, inte mot appen själv). Därför är målet med säkerhetsinställningarna nedan i första hand att begränsa åtkomst på nätverksnivå och skydda mot enkel överbelastning (DoS) — inte sessionshantering.

- **Körs bakom IIS som reverse proxy (rekommenderas i produktion):**
	1. Låt Node lyssna endast lokalt genom att sätta `HOST=127.0.0.1` i `.env` (standardvärde). Node exponeras då aldrig direkt mot nätverket/internet — bara IIS gör det.
	2. Konfigurera en IIS-site med modulen **URL Rewrite** (+ *Application Request Routing*, ARR) som reverse-proxyar till `http://127.0.0.1:3003/`. Aktivera "Enable proxy" i ARR och lägg till en rewrite-regel som matchar `(.*)` → `http://127.0.0.1:3003/{R:1}`.
	3. Sätt `TRUST_PROXY=1` i `.env` så att appen litar på IIS-hoppet och läser klientens riktiga IP från `X-Forwarded-For` (krävs för att rate limiting nedan ska räkna rätt IP istället för IIS-serverns IP).
	4. Låt IIS hantera TLS/HTTPS (certifikat) och ev. IP-begränsningar/brandvägg — Node behöver då inte hantera HTTPS själv.

- **CORS (`ALLOWED_ORIGINS`):** Eftersom appen saknar inloggning bör den nås via en enda känd domän/URL (den som IIS publicerar). Lämna `ALLOWED_ORIGINS` tomt i `.env` — då skickas ingen CORS-header alls och webbläsare tillåter bara anrop från samma origin (rekommenderat läge). Ange bara en kommaseparerad lista (t.ex. `ALLOWED_ORIGINS=https://mgis.example.se`) om ett annat intranät/subdomän uttryckligen ska få anropa API:t direkt från webbläsaren.

- **Rate limiting:** Inbyggt skydd mot enkel överbelastning/skrapning via `express-rate-limit`. Styrs med `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MINUTES` (alla rutter) och `DOWNLOAD_RATE_LIMIT_MAX` / `DOWNLOAD_RATE_LIMIT_WINDOW_MINUTES` (de tyngre nedladdningsstartande rutterna `/create-download` och `/lmv/start-full-download`). Standardvärden: 300 anrop/15 min generellt, 20 nedladdningsstarter/15 min.

- **Helmet:** Används medvetet inte. Helmet är främst till för att skydda sessioner/inloggning (CSP, cookie-flaggor m.m.), vilket inte finns i denna app. De relevanta skydden här är nätverksbegränsning via IIS + `HOST=127.0.0.1`, CORS och rate limiting ovan.

- **Övriga skydd som redan finns i koden:** mappnamn/ID:n som skrivs till disk (t.ex. `collectionId`, nedladdningsmappar) valideras mot ett strikt teckenformat för att förhindra path traversal, och interna felmeddelanden (filsökvägar, stacktraces) loggas bara i `process.log` — aldrig till klienten.

Exempel `.env` för produktion bakom IIS:

```ini
HOST=127.0.0.1
PORT=3003
TRUST_PROXY=1
#ALLOWED_ORIGINS=https://mgis.example.se
RATE_LIMIT_MAX=300
DOWNLOAD_RATE_LIMIT_MAX=20
```

Viktigt om autentisering mot Lantmäteriet (LMV)
- Den här applikationen kan användas med antingen ett **Bearer token** (från API Manager) eller ett **systemkonto** från Geotorget.

- Token (rekommenderat testflöde): Generera ett access token i <https://apimanager.lantmateriet.se/devportal/apis> genom att välja din Application → Production Keys → Select Scopes. Markera scopes för STAC (t.ex. collections och asset‑read) och generera tokenet. I appen välj "Auth token" och klistra in token.

- Systemkonto: Om din organisation föredrar systemkonto, ange systemkonto‑användarnamn i fältet "LMV Användarnamn" och den tilldelade API‑nyckeln/secret i fältet "LMV STAC API Key".
- Nytt: Auth token (Bearer)
	- Applikationen accepterar också ett **Auth token** (Bearer) som alternativ till user/password + X-API-Key. I användargränssnittet finns nu en valbar autentiseringsmetod: "Användarnamn + API-nyckel" eller "Auth token (Bearer)".
	- Om du har ett access token (t.ex. utfärdat av en token-tjänst eller gateway) kan du välja "Auth token" i UI och klistra in token i fältet. Token skickas till servern i fältet `apiToken` och används som HTTP-header `Authorization: Bearer <token>`.

Exempel (curl) — använda Bearer token mot STAC collections:

```bash
# Lista collections med Bearer token
curl -H "Authorization: Bearer <YOUR_TOKEN>" "https://api.lantmateriet.se/stac-vektor/v1/collections"

# Partial GET mot asset med Bearer token
curl -H "Authorization: Bearer <YOUR_TOKEN>" -H "Range: bytes=0-1023" "https://api.lantmateriet.se/path/to/asset.tif"
```

Notera: Om du istället använder user/pass + apiKey (systemkonto) fungerar följande exempel:

```bash
curl -u "SYSTEMUSER:API_KEY" -H "X-API-Key: API_KEY" "https://api.lantmateriet.se/stac-vektor/v1/collections"
```

Hjälp i appen
- Öppna menyn "Hjälp" i appen för en steg-för-steg-guide (sve): `hjalp.html`. Den innehåller länkar till Geotorget, API-portal, STAC-browsern och GBIF.

Webbgränssnitt
- Hem: `/`
- ArtData: `/artdata.html`
- Vektordata: `/lmv.html`
- Höjddata: `/lmv_hojd.html`
- Nedladdningar: `/downloads.html`

Support
- Vid problem, buggar eller frågor om kommersiell support: skriv till **support@mundogis.se**

Behöver ni en färdig Windows-installer eller hjälp med IIS-konfiguration?
Om er organisation önskar en färdig **Windows-installer** som sköter hela installationen automatiskt (Node.js, GDAL/QGIS, tjänsteregistrering m.m.), eller behöver hjälp med att sätta upp och konfigurera **IIS med URL Rewrite/ARR** enligt ovan, kontakta oss gärna på **support@mundogis.se**. Vi på MundoGIS hjälper er mer än gärna med en skräddarsydd installation och driftsättning.

Utvecklad av MundoGIS
