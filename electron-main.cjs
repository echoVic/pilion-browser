/* global console, process */
'use strict';

void import('./dist/main/main/main.js').catch((error) => {
  console.error('Pilion main process failed to load', error);
  process.exitCode = 1;
});
