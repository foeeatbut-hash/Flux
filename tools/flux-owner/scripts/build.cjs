const fs = require('node:fs');
const esbuild = require('esbuild');
fs.mkdirSync('dist',{recursive:true});
for (const name of ['main','preload']) esbuild.buildSync({entryPoints:[`src/${name}.cjs`],outfile:`dist/${name}.cjs`,bundle:true,platform:'node',format:'cjs',external:['electron'],legalComments:'none'});
esbuild.buildSync({entryPoints:['src/vendor/license-core.ts'],outfile:'dist/license-core.cjs',bundle:true,platform:'node',format:'cjs'});
esbuild.buildSync({entryPoints:['src/vendor/updateSignature.ts'],outfile:'dist/updateSignature.cjs',bundle:true,platform:'node',format:'cjs'});
