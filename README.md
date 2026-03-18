
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
- Den här applikationen brukar fungera med ett **systemkonto** från Geotorget (organisationskonto). Ange systemkonto-användarnamn i fältet "LMV Användarnamn" och den API-nyckel/secret som din organisation tilldelat i fältet "LMV STAC API Key".
- Observera: Consumer Key/Consumer Secret som skapas i API-portalen (`https://apimanager.lantmateriet.se/devportal/apis`) fungerar inte alltid för att nå STAC-assets. Om du får behörighetsfel, försök med ditt Geotorget systemkonto och den tilldelade API-nyckeln.

Hjälp i appen
- Öppna menyn "Hjälp" i appen för en steg-för-steg-guide (sve): `hjalp.html`. Den innehåller länkar till Geotorget, API-portal, STAC-browsern och GBIF.

Webbgränssnitt
- Hem: `/`
- ArtData: `/artdata.html`
- Vektordata: `/lmv.html`
- Höjddata: `/lmv_hojd.html`
- Nedladdningar: `/downloads.html`

Säkerhet
- Spara aldrig hemligheter i publika repo.
- LocalStorage är inte krypterat — använd med försiktighet.

Support
- För frågor: info@mundogis.se

Utvecklad av MundoGIS
