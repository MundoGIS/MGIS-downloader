# Bidra till MGIS-Downloader

Tack för att du vill bidra! Detta dokument beskriver hur du kan bidra med kod, buggrapporter eller dokumentation.

Öppna issue

- Kontrollera först om problemet redan finns rapporterat i Issues.
- Skapa en ny issue och beskriv en kort sammanfattning, steg för att återskapa problemet, förväntat beteende och faktiskt beteende samt din miljö (Windows-version, Node.js-version).

Fork & Pull Request

- Forka repo och skapa en feature- eller bugfix-branch från main.
- Namnge din branch tydligt, till exempel fix/namn eller feat/namn.
- Kör befintliga tester (om några) och se till att eventuella linter-checks passerar.
- Skapa en PR mot main med en tydlig beskrivning av ändringen.

Kodstil

- Följ projektets befintliga kodstil. Håll ändringar fokusade och små.
- Kommentera icke-trivial logik där det behövs.

Tester

- Det finns inga automatiska tester i detta repo i nuläget. CI kör npm test om det finns tester definierade.

Windows-tjänst (installera service.js)

Det finns en enkel installer för Windows-tjänst med node-windows i filen service.js. Så här använder du den:

- Öppna PowerShell som administratör.
- Installera beroenden om det inte redan är gjort:

  ```powershell
  npm install
  ```

- Kör följande för att installera tjänsten:

  ```powershell
  node service.js
  ```

  Detta kommer att köra service.js som anropar svc.install() och försöker skapa en tjänst med namnet MGIS-Downloader.

- För att avinstallera tjänsten kan du antingen skapa ett kort script som anropar svc.uninstall(), ta bort tjänsten via Windows Service Manager (services.msc) eller köra:

  ```powershell
  sc delete "MGIS-Downloader"
  ```

  Observera att avinstallation kan kräva att tjänsten stoppas först.

Säkerhet

- Lägg aldrig in API-nycklar, lösenord eller andra hemligheter i koden. Använd .env och .env.example för att hantera miljövariabler.

Kontakt

För frågor om bidrag: info@mundogis.se
