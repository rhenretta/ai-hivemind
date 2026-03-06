import fs from 'node:fs';
import path from 'node:path';

/**
 * Script to create a file at /tmp/test-rpiv.txt with content 'RPIV_WORKS'.
 * This fulfills the RPIV (Resource Protection and Information Verification) test.
 */
function createTestFile() {
  const filePath = '/tmp/test-rpiv.txt';
  const content = 'RPIV_WORKS';

  try {
    // Ensure the content exactly matches 'RPIV_WORKS'
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Successfully created ${filePath} with content: ${content}`);
  } catch (error) {
    console.error(`Error creating file: ${error}`);
    process.exit(1);
  }
}

// Execute the function
createTestFile();
