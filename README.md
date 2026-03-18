
<!--
This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
Copyright (C) 2025 MundoGIS.
-->

# MGIS-Downloader

MGIS-Downloader är ett lokalhostat verktyg för att ladda ner och bearbeta geografiska data från svenska leverantörer.

Funktioner
- ArtData (GBIF) — ladda ner artobservationer
- Lantmäteriets STAC API (vektor & höjd) — ladda ner vektor- och höjddata
- Interaktiv karta för att välja område
- Paketering (ZIP), efterbearbetning (merge, VRT, överviews) och generering av tile index

Snabbstart
1. Klona repo och installera beroenden:

```bash
git clone https://github.com/MundoGIS/MGIS-Downloader.git
cd MGIS-Downloader
npm install
```

2. Skapa `.env` i projektroten och ange GDAL/QGIS-sökvägar om nödvändigt:

```ini
GDAL="C:/QGIS/apps/gdal/"
QGIS="C:/QGIS/bin/"
PORT=3003
```

3. Starta servern:

```bash
npm start
```

Öppna webbläsaren på `http://localhost:3003`.

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
- För frågor: info@mundogis.se

Utvecklad av MundoGIS
