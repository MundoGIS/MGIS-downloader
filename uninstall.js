
/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */


const Service = require('node-windows').Service;

// Crea un nuevo objeto de servicio
const svc = new Service({
  name: 'MGIS-Downloader',
   description: 'ArtData och LMV data',
  script: 'server.js',
  nodeOptions: [
    '--harmony', // Si tienes otras opciones, inclúyelas aquí
    '--max-old-space-size=8192' // Agregar el límite de memoria
  ]
});

// Define eventos para el servicio
svc.on('uninstall', function() {
  console.log('Servicio desinstalado correctamente.');
});

// Desinstala el servicio
svc.uninstall();
