'use strict';

require('./index').main().catch((error) => {
  console.error('[Fatal]', error);
  process.exitCode = 1;
});
