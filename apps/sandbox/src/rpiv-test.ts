import fs from 'node:fs';
import path from 'node:path';

const filePath = '/tmp/test-rpiv.txt';
const content = 'RPIV_WORKS';

try {
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Successfully created ${filePath} with content: ${content}`);
} catch (error) {
  console.error(`Error creating file: ${error}`);
  process.exit(1);
}
