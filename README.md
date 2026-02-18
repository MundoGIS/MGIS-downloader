
<!--
This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
Copyright (C) 2025 MundoGIS.
-->

# MGIS-Downloader

## MGIS-Downloader

<!-- QUICK START -->
## Quick Start (snabbt igång)

En webbapplikation utvecklad av **MundoGIS** för att ladda ner och bearbeta geografisk data från svenska myndigheter.

## Översikt

MGIS-Downloader är ett verktyg som gör det möjligt att enkelt ladda ner och hantera geografisk data från:

- **ArtData (GBIF)** - Artobservationer och biologisk mångfald
- **Lantmäteriet Vektordata** - Marktäcke, Byggnader och fastighetsindelning via STAC API
- **Lantmäteriet Höjddata** - Markhöjdmodeller (DEM) via STAC API

### Huvudfunktioner

- 🗺️ **Interaktiv karta** med Leaflet för att välja nedladdningsområde
- 📦 **Automatisk nedladdning** med filtrering per geografiskt område
- 💾 **Datahantering** - lista, ladda ner som ZIP, och ta bort nedladdningar
- 🔐 **Säker inloggning** med möjlighet att spara användaruppgifter lokalt
- 🇸🇪 **Svenskt gränssnitt** anpassat för svenska användare

## Systemkrav

- **Windows 10/11** eller Windows Server (64-bit)
- **Node.js 18** eller nyare
- **QGIS/OSGeo4W** - tillhandahåller GDAL-verktyg för rasterbearbetning
- **Git** (rekommenderas) för att klona repositoryt

## Installation

### 1. Installera QGIS/OSGeo4W

### 2. Klona repositoryt

```bash
git clone https://github.com/MundoGIS/MGIS-downloader.git
cd MGIS-Downloader
```

npm install
```

### 4. Konfigurera miljövariabler

Skapa en `.env`-fil i projektets rot:

```ini
GDAL="C:/QGIS/apps/gdal/"
QGIS="C:/QGIS/bin/"
PORT=3003
```

Justera sökvägarna om du installerade QGIS på en annan plats.

### 5. Starta servern

```bash
npm start
```

Servern körs på `http://localhost:3003` (eller den port du angett).

## Användning

### Webbgränssnitt
<!--
Denna källkod är licensierad under Mozilla Public License 2.0.
Se https://mozilla.org/MPL/2.0/ för licensvillkor.
Copyright (C) 2026 MundoGIS.
-->

# MGIS-Downloader

En webbapplikation utvecklad av MundoGIS för att ladda ner och bearbeta geografiska data från svenska leverantörer.

## Snabbstart

Följ dessa steg för att komma igång lokalt på Windows:

1. Klona repositoryt och gå till mappen:

```bash
git clone https://github.com/MundoGIS/MGIS-Downloader.git
cd MGIS-Downloader
```

2. Installera beroenden:

```bash
npm install
```

3. Skapa en `.env`-fil baserat på `.env.example` och justera sökvägar:

```ini
# Exempel på variabler
GDAL="C:/QGIS/apps/gdal/"
QGIS="C:/QGIS/bin/"
PORT=3003
```

4. Starta servern:

```bash
npm start
```

Servern startar som standard på `http://localhost:3003` (eller den port du anger i `PORT`).

## Översikt

MGIS-Downloader kan användas för att hämta data från:

- ArtData (GBIF)
- Lantmäteriets STAC API (vektor och höjd)

Huvudfunktioner:

- Interaktiv karta med Leaflet för att välja område
- Nedladdning och paketering av data (ZIP)
- Enkel hantering av nedladdningar i webgränssnittet

## Webbgränssnitt

Efter att servern körs, öppna webbläsaren och navigera till:

- Hem: `http://localhost:3003/`
- ArtData: `http://localhost:3003/artdata.html`
- Vektordata: `http://localhost:3003/lmv.html`
- Höjddata: `http://localhost:3003/lmv_hojd.html`
- Nedladdningar: `http://localhost:3003/downloads.html`

## Projektstruktur (översikt)

```
MGIS-Downloader/
├── public/              # Frontend-filer
├── data/                # Geojson och liknande (ignoreras i Git)
├── server.js            # Backend Express-server
├── service.js           # Windows-service-installer
├── package.json
└── .env.example         # Mall för miljövariabler
```

## Systemkrav

- Windows 10/11 eller Windows Server (64-bit)
- Node.js 18 eller nyare
- QGIS/OSGeo4W med GDAL (om du behöver rasterbearbetning)

## Säkerhet och nycklar

Den här applikationen använder API-nycklar och inloggningsuppgifter för externa tjänster. Lägg aldrig in hemligheter i källkoden eller i publika repo.

Tips:

- Lägg till dina värden i `.env` och lägg aldrig upp den filen i Git.
- Applikationen erbjuder en funktion för att spara API-nycklar i `localStorage` i webbläsaren — detta är inte krypterat och bör användas med försiktighet.

## CI / Test

Det finns en enkel GitHub Actions-workflow i `.github/workflows/nodejs.yml` som kör `npm install` och `npm test`.

## Licens

Detta projekt licensieras under Mozilla Public License 2.0 (MPL-2.0).

## Support

För kommersiell support eller frågor, kontakta: info@mundogis.se

Utvecklad av MundoGIS © 2026
