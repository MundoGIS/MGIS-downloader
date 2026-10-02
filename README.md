1. Vänta tills nedladdningsjobbet är **klart**. Öppna **Nedladdningar** och välj *Upplösning XYZ*: *Original* eller 10/20/50/100 m. Detta begränsar detaljzoom som beräknas; högre zoomnivåer förstoras från föregående nivå. Välj *Ljusvinkel* 15–80° (standard 35) och *Reliefstyrka* 0,5–3 (standard 1,7). Mappar med TIFF/COG eller VRT kan publiceras.
3. För QGIS välj **XYZ Tiles > New Connection** och klistra in enbart URL:en från **Kopiera länk** (inte CSS, HTML eller WMS). Om QGIS körs på en annan dator ska `localhost` ersättas med serverns nåbara värdnamn/IP; privata kataloger accepterar API-nyckeln som query-parameter i URL:en. Första anropet renderar en tile ur källan och cachar PNG:n. När en ny höjdområdesnedladdning är klar uppdateras samma katalog till samlingens nya `index.vrt` och den gamla servercachen ogiltigförklaras; kartklienten behöver inte en ny XYZ-datakälla.

VRT-sökvägen visas separat i katalogkortet och kan kopieras för att öppna VRT direkt i QGIS **på serverdatorn**. Den är en lokal filsökväg vars käll-TIFF:er ligger på serverns disk; den ska inte användas som URL i en QGIS-klient på en annan dator. För fjärrklienter använd XYZ-länken.
3. Kopiera URL:en `/terrain/<alias>/tiles/{z}/{x}/{y}.png` till en **XYZ-kapabel** kartklient (t.ex. Hajk, Origo eller QGIS XYZ Tiles). Första anropet renderar en tile ur källan och cachar PNG:n; efterföljande anrop använder disken. Rendering sker i en begränsad kö. När en ny höjdområdesnedladdning är klar uppdateras samma katalog till samlingens nya `index.vrt` och den gamla servercachen ogiltigförklaras; Hajk/Origo/QGIS behöver alltså inte en ny XYZ-datakälla. Zoomnivåerna finns till och med 22, men ger inte mer detalj än källrastret. Tjänsten är inte WMS/WMTS.
generera PNG XYZ-tiles först när de efterfrågas. Beräkningen reprojicerar en liten källruta till EPSG:3857 och gör hillshade (justerbar ljusvinkel och reliefstyrka); färdiga tiles sparas i en storleksbegränsad diskcache. Källfilerna lämnas orörda.
generera PNG XYZ-tiles först när de efterfrågas. Beräkningen reprojicerar en liten källruta till EPSG:3857 och gör hillshade (justerbar ljusvinkel och reliefstyrka); färdiga tiles sparas i en storleksbegränsad diskkassa. Källfilerna lämnas orörda.
Diskutrymme för nedladdade TIFF/COG och en tile-cache (standard högst 20 GB per katalog); ingen full XYZ-pyramid skapas vid publicering.
registrera TIFF/COG eller befintligt VRT och generera PNG XYZ-tiles först när de efterfrågas. Beräkningen reprojicerar en liten källruta till EPSG:3857 och gör hillshade (justerbar ljusvinkel och reliefstyrka); färdiga tiles sparas i en storleksbegränsad diskkcache. Källfilerna lämnas orörda.

<!--
This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
Copyright (C) 2025 MundoGIS.
-->

# MGIS-Downloader

MGIS-Downloader är en Node.js-app för att hämta svenska geodata och publicera höjddata som skuggade XYZ-karttiles. Appen har ett inloggat webbgränssnitt för nedladdning och administration samt separata, valbart publika karttjänster. Den är inte en WMS- eller WMTS-server.

## Funktioner

- **ArtData/GBIF:** sök arter och antal observationer, begär GBIF-nedladdningar och hämta resultat. GBIF-konto och datamängdernas egna licensvillkor krävs.
- **Lantmäteriet STAC:** hämta vektor- och höjddata med systemkonto/API-nyckel eller Bearer-token. Välj samling och område via Leaflet, rektangel, polygon, län eller uppladdad GeoJSON-fil med flera polygoner. Uppladdade polygoner finns i webbläsarens minne under sessionen; EPSG:4326, EPSG:3857 och EPSG:3006 hanteras för områdesvalet. Okända/omärkta CRS ska inte förutsättas fungera.
- **Nedladdningsjobb:** live-status, avbryt, återanvänd redan hämtade filer, bearbeta höjdraster, skapa VRT/tile-index och hämta färdiga mappar som ZIP. `LMV_DOWNLOADS_*` innehåller källmaterialet.
- **Terrängpublicering:** välj *Original* eller 10/20/50/100 m när nedladdningen är klar. GDAL sammanfogar, transformerar till EPSG:3857, beräknar hillshade (justerbar ljusvinkel och reliefstyrka) och skapar PNG XYZ-tiles. Namnge katalogen själv, följ publiceringsstatus och publicera om med annan stil. Källfilerna lämnas orörda.
- **Terrängpublicering:** registrera TIFF/COG eller befintligt VRT och generera PNG XYZ-tiles först när de efterfrågas. Beräkningen reprojicerar en liten källruta till EPSG:3857 och gör hillshade (justerbar ljusvinkel och reliefstyrka); färdiga tiles sparas i en begränsad diskkö. Källfilerna lämnas orörda.
- **Kartklienter:** kopiera XYZ-URL för t.ex. Hajk, Origo och QGIS XYZ Tiles. XYZ skapas vid behov till zoom 22; zoomnivån styr detaljen som läses ur källrastret och skapar inte ny information.
- **QGIS med GDAL på samma dator som Node** för det verifierade Windows-flödet. IIS, Hajk, Origo och QGIS som *kartklient* kan nås på andra datorer, men GIS-verktygen måste finnas lokalt hos appen. Rasterpublicering använder `gdalbuildvrt`, `gdalinfo`, `gdalwarp` och `gdaldem`; nedladdningsflödet använder även `gdal_translate` och kan använda Python-verktyg som `gdal_merge.py`.
Installera Node.js 18+ och QGIS **på samma server**. Anteckna katalogerna för `apps/gdal` och `bin` (QGIS-installationskatalog kan skilja sig). Klona projektet och installera npm-beroenden:
- **Åtkomst:** lokala konton med admin- och användarroll, privat/public-läge per kartkatalog, engångsvisad API-nyckel för privata tiles, nyckelrotation samt avpublicering. Endast admin får administrera konton och radera nedladdningsmappar; radering av mapp tar också bort tillhörande publicerade kataloger.

## Krav

- Node.js **18+** och npm på datorn som kör servern.
- **QGIS med GDAL och tillhörande Python på samma dator som Node** för det verifierade Windows-flödet. IIS, Hajk, Origo och QGIS som *kartklient* kan nås på andra datorer, men GIS-verktygen som bearbetar raster måste finnas lokalt hos appen. Publicering kräver `gdalbuildvrt`, `gdalinfo`, `gdal_translate`, `gdalwarp`, `gdaldem`, QGIS Python och `gdal2tiles.py`; andra nedladdningssteg kan även använda GDAL/Python-verktyg som `gdal_merge.py`.
- Diskutrymme för både nedladdade TIFF/COG och den färdiga terrängkatalogen; upplösning och område avgör hur mycket plats och tid som går åt.
- Nätåtkomst till Lantmäteriets och GBIF:s API:er samt till kartans/CDN:ernas resurser om de används i webbläsaren. Tillgång till data styrs separat av respektive leverantör.

Installations- och publiceringsflödet nedan är verifierat med **Windows + QGIS + IIS**. Linux/macOS kräver motsvarande lokala GDAL/Python-binärer och egna verktygssökvägar; den automatiska QGIS-sökvägen är Windows-orienterad.

## Installation på Windows

1. Installera Node.js 18+ och QGIS **på samma server**. Anteckna katalogerna för `apps/gdal`, `bin` och `apps/Python312/Scripts/gdal2tiles.py` (Python-version och QGIS-installationskatalog kan skilja sig). Klona projektet och installera npm-beroenden:

	```powershell
	git clone https://github.com/MundoGIS/MGIS-Downloader.git
	cd MGIS-Downloader
	npm.cmd install
	```

2. Skapa `.env` i projektroten, exempelvis för QGIS installerat i `C:/QGIS_344`:

	```ini
	PORT=3004
	HOST=127.0.0.1
	GDAL=C:/QGIS_344/apps/gdal
	QGIS=C:/QGIS_344/bin
	# Sätt bara dessa om automatisk sökväg inte stämmer:
	```

	`HOST=127.0.0.1` binder Node lokalt; exponera inte port 3004 direkt på internet. Programmet kontrollerar nödvändiga GDAL-binärer vid start och vid publicering. Anpassa sökvägarna till **din** QGIS-installation. `.env` ska inte versionshanteras.

3. Skapa första administratören **innan extern åtkomst öppnas**:

	```powershell
	npm.cmd run admin:init
	```

	Ange ett eget användarnamn (3–40 bokstäver/siffror samt `.`, `_` eller `-`) och ett dolt lösenord på minst **6 tecken**, högst 72 UTF-8-byte. Ett långt unikt lösenord rekommenderas. **Ingen förinställd admin eller lösenord finns.** Första kontot kan skapas en gång med detta kommando; därefter sköter admin konton under **Användare** i appen.

4. Starta med `npm.cmd start` och öppna `http://127.0.0.1:3004/login.html` lokalt. Bakom IIS ska du använda din publika **HTTPS-adress**. Om inga admin-konton finns visar inloggningssidan instruktioner; uppdatera sidan efter att kontot skapats. För att testa kör du `npm.cmd test`.

Har projektets `package-lock.json` olösta Git-konflikter måste dessa lösas innan `npm ci` kan användas i driftsättning. Kör inte `npm audit fix --force` blint på produktionsmiljön. Varje server som ska bearbeta raster måste ha QGIS/GDAL/Python lokalt; en QGIS-installation bara på administratörens dator räcker inte.

## Drift, inloggning och IIS

**Windows:** `npm.cmd run service:install` installerar tjänsten med `node-windows`; `npm.cmd run service:uninstall` tar bort den. Prova vanlig start och kontrollera QGIS-verktygen innan tjänsten installeras. **Linux:** `scripts/install-linux-service.sh` är ett systemd-skript men publiceringskedjans GDAL- och Python-sökvägar måste först anpassas och testas på samma värd. Starta aldrig om Node medan ett nedladdnings- eller publiceringsjobb arbetar: jobbstatus finns i processens minne.

Appkonton lagras utanför `public/` i ignorerade `data/users.json` (eller absolut sökväg via `USERS_FILE`). Lösenord lagras som **bcrypt-hash**, inte klartext. Vanliga sessioner ligger i minnet i högst åtta timmar; *Kom ihåg mig* använder en HttpOnly-cookie i 30 dagar och en **hash av sessionstoken** i `data/remembered_sessions.json` (`SESSIONS_FILE` kan ändra sökvägen). Lösenords-/rolländring och utloggning återkallar relevanta sessioner. En admin kan skapa, byta namn på, ändra roller/lösenord för och radera användare. En vanlig användare får använda appen men varken administrera användare eller radera nedladdningsmappar. Konton/sessioner i JSON är avsedda för **en Node-process**; skydda och säkerhetskopiera filerna med rätt filrättigheter. Appens sessionsval är separat från leverantörsinloggningar: LMV-uppgifter sparas inte längre i webbläsaren, men GBIF-sidan har fortfarande ett eget sparval som inte bör användas på delade klientdatorer.

IIS på samma maskin terminerar TLS och proxar med **URL Rewrite + Application Request Routing** till `http://127.0.0.1:3004/`. Låt `HOST=127.0.0.1` vara kvar; öppna inte Node-porten externt. Vidarebefordra korrekt publikt `Host` (eller `X-Forwarded-Host`) och `X-Forwarded-Proto: https`, och rensa bort klientskapade `X-Forwarded-*`-headers i IIS. Express litar endast på forwarding från loopback; inloggning och skrivande API-anrop kontrollerar begärans origin, och HTTPS-sessioner får `Secure`, `HttpOnly`, `SameSite=Strict`-cookies. Ställ in brandvägg/filrättigheter och undvik proxycache på inloggade sidor. Detta är skyddsmekanismer, inte en formell säkerhetscertifiering; testa IIS-regler, HTTPS och återställning i din driftsmiljö. Se även [AUTH.md](AUTH.md).

## Publicera höjddata

1. Vänta tills nedladdningsjobbet är **klart**. Öppna **Nedladdningar** och välj *Original* (GDAL väljer pixelstorlek) eller 10, 20, 50 eller 100 m. Välj *Ljusvinkel* 15–80° (standard 35) och *Reliefstyrka* 0,5–3 (standard 1,7). Lägre ljusvinkel och högre reliefstyrka ger mörkare/tydligare skuggor.
1. Vänta tills nedladdningsjobbet är **klart**. Öppna **Nedladdningar** och välj *Ljusvinkel* 15–80° (standard 35) och *Reliefstyrka* 0,5–3 (standard 1,7). Lägre ljusvinkel och högre reliefstyrka ger mörkare/tydligare skuggor. Mappar med TIFF/COG eller VRT kan publiceras.
2. Klicka **Publicera XYZ**, ange katalogalias och följ statusen i samma nedladdningskort. Publicering bygger bara ett VRT-index för TIFF-filer eller registrerar ett VRT som redan finns; inget stort raster omprojiceras och inga pyramider byggs i förväg. Vid ändring av stil väljer du **Publicera om**. Undvik samtidigt arbete mot samma källmapp.
3. Kopiera URL:en `/terrain/<alias>/tiles/{z}/{x}/{y}.png` till en **XYZ-kapabel** kartklient (t.ex. Hajk, Origo eller QGIS XYZ Tiles). Första anropet renderar en tile ur källan och cachar PNG:n; efterföljande anrop använder disken. Rendering sker i en begränsad kö. Zoomnivåerna finns till och med 22, men ger inte mer detalj än källrastret. Tjänsten är inte WMS/WMTS.

Cache och samtidighet kan ställas in i `.env`: `ON_DEMAND_TILE_CONCURRENCY` (standard 2), `ON_DEMAND_TILE_QUEUE` (64 väntande tiles) och `TERRAIN_CACHE_MAX_GB` (20 GB per katalog). Cache ligger separat från publicerade resurser och tas bort vid avpublicering. En tile som inte finns i cache måste räknas om efter omstart endast om cachen har rensats.
Nedladdade original ligger under `LMV_DOWNLOADS_*`, metadata för publicering under `terrain/`, VRT-indices som appen skapar under `terrain-sources/`, tile-cachar under `terrain-cache/`, katalogindex i `terrain_catalogs.json` och konton/sessioner i `data/users.json`/`data/remembered_sessions.json`. Dessa driftsfiler ska hanteras som lokalt data, inte som källkod; skydda åtkomsten och säkerhetskopiera det som ska bevaras.

Nya kataloger är **privata** som standard. I katalogkortet kan du slå på **Public** för anonym läsning av XYZ-tiles eller använda en unik API-nyckel för privat läsning (`X-API-Key` eller `?api_key=...` i klientens HTTPS-URL). Nyckeln visas bara vid skapande/rotation, servern lagrar bara SHA-256-hash. Spara länken säkert; rotering upphäver gamla nycklar direkt. Nycklar i URL kan hamna i IIS-loggar och klientkonfiguration. Äldre kataloger utan åtkomstflagga förblir publika tills de ändras. **Avpublicera** raderar publicerade tiles men behåller nedladdningen; admin-knappen **Ta bort** raderar källmappen och dess tillhörande publicerade kataloger. Åtkomstkontroll för dessa åtgärder sker även i servern.

## Dataleverantörer och kartor

Lantmäteriets STAC-åtkomst kräver separat rätt till de samlingar och filer organisationen hämtar. Välj **Användarnamn + API-nyckel** (systemkonto från Geotorget) eller **Auth token (Bearer)** från API Manager med relevanta scopes. Servern kontrollerar åtkomsten före nedladdning; appens eget admin-/användarkonto ersätter **inte** ett LMV-konto. Läs licensvillkoren för vald samling innan data används eller publiceras.

ArtData använder GBIF:s API och kräver separata GBIF-uppgifter. GBIF-observationer kan komma från olika dataset med **olika** datalicenser; kontrollera varje dataset före vidarepublicering. Baskartan i Leaflet laddas från OpenStreetMap: behåll dess attribution och följ deras regler för tile-användning. Appen inkluderar inte rättigheter att vidarepublicera data bara för att den kan hämta och bearbeta dem.

Webbsidor: `/` (start), `/artdata.html`, `/lmv.html` (vektor), `/lmv_hojd.html` (höjd), `/downloads.html` (jobb/kataloger), `/admin.html` (endast admin), `/hjalp.html` och `/login.html`. Sidor och administrativa API:er kräver inloggning. Publicerade XYZ-tiles kan läsas anonymt **bara** om den aktuella katalogen är Public; privata tiles kräver giltig katalognyckel. Använd den kopierade HTTPS-URL:en, inte `localhost:3004`, när kartklienten kör på en annan dator.

## Drift och felsökning

- Kontrollera QGIS/GDAL-sökvägar och att den aktuella tjänsteanvändaren får köra verktygen. `process.log` innehåller jobbloggar; kontrollera ledigt diskutrymme, IIS-proxy och åtkomst till leverantörernas API:er om nedladdning eller publicering misslyckas. LMV-uppgifter sparas inte av de aktuella LMV-sidorna; tidigare Base64-lagrade LMV-uppgifter rensas från webbläsarens `localStorage` när appen öppnas. Uppgifterna måste anges på nytt. Rensa webbplatsdata även för andra tidigare använda domäner/origins (t.ex. både lokal adress och IIS-DNS) om de har använts. Lösenord och API-nycklar ska aldrig skickas via supportärenden.
- Nedladdade original ligger under `LMV_DOWNLOADS_*`, publicerade raster/tiles under `terrain/`, katalogindex i `terrain_catalogs.json` och konton/sessioner i `data/users.json`/`data/remembered_sessions.json`. Dessa driftsfiler ska hanteras som lokalt data, inte som källkod; skydda åtkomsten och säkerhetskopiera det som ska bevaras.
- Om QGIS bara är installerat på en klientdator kan du fortfarande öppna en publicerad karta där, men **Node-servern kan inte generera eller ompublicera tiles** utan GIS-verktygen på sin egen värd. Mycket hög XYZ-zoom förstorar befintlig information, inte höjdmodellens noggrannhet.
- Källkoden är licensierad enligt [LICENSE](LICENSE). Se [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) för tredjepartskomponenter och leverantörernas licenshänvisningar. Granska deras fullständiga villkor vid paketering/vidaredistribution; notisfilen är inte ett juridiskt godkännande.

Frågor, buggar eller hjälp med IIS/QGIS-installation: **support@mundogis.se**. Utvecklad av MundoGIS.
