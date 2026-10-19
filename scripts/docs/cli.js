import { check, build } from './site.js';

const command = process.argv[2];
try {
  if (command === 'check') {
    const result = await check(process.cwd());
    console.log(`Checked ${result.pages.length} published pages and ${result.assets.length} assets.`);
  } else if (command === 'build') {
    const result = await build(process.cwd());
    console.log(`Built ${result.pages.length} pages in site/.`);
  } else {
    throw new Error('Use "check" or "build".');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
