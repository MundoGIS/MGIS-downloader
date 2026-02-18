/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */
const translations = {
    'sv': { // Swedish (Svenska)
        'pageTitle': "Ladda ner GBIF-data",
        'mainHeading': "Ladda ner GBIF-data",
        'usernameLabel': "GBIF-användarnamn:",
        'passwordLabel': "GBIF-lösenord:",
        'speciesSelectLabel': "Välj art (eller alla):",
        'speciesSelectDefault': "-- Välj en art eller \"Alla arter\" --",
        'speciesAll': "** Alla arter **",
        // ... add all other species names if needed, or keep them static
        'basisLabel': "Typ av fynd:",
        'basisAll': "-- Alla --",
        // ... all basis options ...
        'areaLegend': "Definiera område (Bounding Box)",
        'areaInfo': "Definiera område genom att rita en rektangel på kartan ELLER fylla i koordinatfälten nedan.",
        'minLonLabel': "Min Lon:", 'maxLonLabel': "Max Lon:",
        'minLatLabel': "Min Lat:", 'maxLatLabel': "Max Lat:",
        'coordPlaceholder': "-180 till 180", 'latCoordPlaceholder': "-90 till 90", // Reuse or specify
        'verifyBtn': "Verifiera art / Förbered nedladdning",
        'downloadBtn': "Starta nedladdning",
        'foundLabel': "Filter inställda för:", // Text before species name/count
        'areaLabel': "inom definierat område.", // Text after species name/count
        'downloadStarted': "Nedladdningsbegäran har startats.",
        'downloadKeyLabel': "Nedladdningsnyckel:",
        'emailInfo': "Du kommer att få ett e-postmeddelande från GBIF när datan är redo.",
        'manualSaveInfo': "VIKTIGT: När du laddar ner .zip-filen från GBIF-länken, måste du spara eller manuellt flytta filen till din mål-mapp:",
        // Error/Success/Info Messages
        'errorUserPass': "Vänligen ange GBIF användarnamn och lösenord.",
        'errorSpeciesSelect': "Vänligen välj en art eller \"Alla arter\".",
        'errorCoordsEmpty': "Vänligen fyll i alla koordinater för området.",
        'errorCoordsInvalid': "Ogiltiga koordinater. Kontrollera värdena (-180<=Lon<=180, -90<=Lat<=90, min<max).",
        'errorDefineArea': "Vänligen definiera ett giltigt område (antingen via fälten eller genom att rita på kartan).",
        'infoVerifying': "Verifierar art: {speciesName}...", // {variable} for interpolation
        'successSpeciesFound': "Art hittad: {scientificName}. Förberedd för nedladdning inom definierat område.",
        'errorSpeciesNotFound': "Art inte hittad i GBIF.",
        'errorVerification': "Fel vid artverifiering: {errorMessage}",
        'infoCount': "Hämtar antal förekomster för {displayName}...",
        'successCount': "Filter inställda. Redo att ladda ner data.", // Base message
        'textCount': "{displayName} (ca {count} förekomster)", // Added to foundSpeciesName
        'errorCount': "Kunde inte hämta antal förekomster: {errorMessage}. Du kan försöka starta nedladdningen ändå.",
        'errorCountFallbackText': "{displayName} (antal okänt)",
        'errorDownloadPrep': "Nödvändig information saknas (art/ALLA, område). Förbered/verifiera igen.",
        'successDownload': "Nedladdningsbegäran startad korrekt.",
        'errorDownload': "Fel vid skapande av nedladdning: {errorMessage}",
        'errorDownloadGeneric': "Servern indikerade ett fel vid skapandet av nedladdningen.",
        'mapDrawSuccess': "Område definierat på kartan. Koordinatfälten har uppdaterats.",
        'mapDrawDeleted': "Området har tagits bort från kartan.",
        'mapDrawEdited': "Området har redigerats på kartan. Koordinatfälten har uppdaterats."
    },
    'en': { // English
        'pageTitle': "Download GBIF Data",
        'mainHeading': "Download GBIF Data",
        'usernameLabel': "GBIF Username:",
        'passwordLabel': "GBIF Password:",
        'speciesSelectLabel': "Select Species (or all):",
        'speciesSelectDefault': "-- Select a species or \"All species\" --",
        'speciesAll': "** All species **",
        'basisLabel': "Basis of Record:",
        'basisAll': "-- All --",
        'basisPRESERVED_SPECIMEN': "Preserved Specimen", // Need keys for dynamic options too
        'basisHUMAN_OBSERVATION': "Human Observation",
        'basisOBSERVATION': "Observation (general)",
        // ... other basis options ...
        'areaLegend': "Define Area (Bounding Box)",
        'areaInfo': "Define the area by drawing a rectangle on the map OR filling in the coordinate fields below.",
        'minLonLabel': "Min Lon:", 'maxLonLabel': "Max Lon:",
        'minLatLabel': "Min Lat:", 'maxLatLabel': "Max Lat:",
        'coordPlaceholder': "-180 to 180", 'latCoordPlaceholder': "-90 to 90",
        'verifyBtn': "Verify Species / Prepare Download",
        'downloadBtn': "Start Download",
        'foundLabel': "Filters set for:",
        'areaLabel': "within defined area.",
        'downloadStarted': "Download request has been started.",
        'downloadKeyLabel': "Download key:",
        'emailInfo': "You will receive an email from GBIF when the data is ready.",
        'manualSaveInfo': "IMPORTANT: When you download the .zip file from the GBIF link, you must save or manually move the file to your target folder:",
        // Error/Success/Info Messages
        'errorUserPass': "Please enter GBIF username and password.",
        'errorSpeciesSelect': "Please select a species or \"All species\".",
        'errorCoordsEmpty': "Please fill in all coordinates for the area.",
        'errorCoordsInvalid': "Invalid coordinates. Check values (-180<=Lon<=180, -90<=Lat<=90, min<max).",
        'errorDefineArea': "Please define a valid area (either via the fields or by drawing on the map).",
        'infoVerifying': "Verifying species: {speciesName}...",
        'successSpeciesFound': "Species found: {scientificName}. Prepared for download within defined area.",
        'errorSpeciesNotFound': "Species not found in GBIF.",
        'errorVerification': "Error during species verification: {errorMessage}",
        'infoCount': "Fetching occurrence count for {displayName}...",
        'successCount': "Filters set. Ready to download data.",
        'textCount': "{displayName} (approx. {count} occurrences)",
        'errorCount': "Could not fetch occurrence count: {errorMessage}. You can still try to start the download.",
        'errorCountFallbackText': "{displayName} (count unknown)",
        'errorDownloadPrep': "Necessary information missing (species/ALL, area). Please prepare/verify again.",
        'successDownload': "Download request started successfully.",
        'errorDownload': "Error creating download: {errorMessage}",
        'errorDownloadGeneric': "The server indicated an error creating the download.",
        'mapDrawSuccess': "Area defined on map. Coordinate fields updated.",
        'mapDrawDeleted': "Area has been removed from the map.",
        'mapDrawEdited': "Area has been edited on the map. Coordinate fields updated."
    }
    // Add more languages here (e.g., 'es', 'fi', 'no')
};