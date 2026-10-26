import fs from 'fs';

const HTTP_CLIENT_FILE = 'src/__generated__/http-client.ts';
const GENERATED_SERVER_FILE = 'src/__generated__/server.ts';
const HANDLERS_FILE = 'src/__generated__/handlers.ts';
const CUSTOM_FETCH_IMPORT = 'import { customFetch as fetch } from "../api/custom-fetch";';

function addCustomFetchImport() {
  if (!fs.existsSync(HTTP_CLIENT_FILE)) {
    console.log(`File ${HTTP_CLIENT_FILE} not found`);
    return;
  }

  const content = fs.readFileSync(HTTP_CLIENT_FILE, 'utf8');
  const lines = content.split('\n');
  
  // Check if import already exists
  if (lines.some(line => line.includes('import { customFetch as fetch }'))) {
    console.log('customFetch import already exists');
    return;
  }
  
  // Find the line with http-schemas import
  const importIndex = lines.findIndex(line => line.includes('} from \'./http-schemas\';'));
  
  if (importIndex === -1) {
    console.log('Could not find http-schemas import line');
    return;
  }
  
  // Insert the customFetch import after the http-schemas import
  lines.splice(importIndex + 1, 0, CUSTOM_FETCH_IMPORT);
  
  fs.writeFileSync(HTTP_CLIENT_FILE, lines.join('\n'));
  console.log('Added customFetch import to http-client.ts');
}

function removeGeneratedServer() {
  if (fs.existsSync(GENERATED_SERVER_FILE)) {
    fs.unlinkSync(GENERATED_SERVER_FILE);
    console.log('Removed generated server.ts file');
  }
}

function removeUnusedUploadBodyImport() {
  // Orval 7.10.0 imports this type for the binary upload endpoint, but does
  // not generate the type or use it in a handler. Keep the workaround narrow:
  // if a future generator starts using the type, fail instead of removing it.
  const content = fs.readFileSync(HANDLERS_FILE, 'utf8');
  const references = content.match(/\bUploadAttachmentFileBody\b/g) ?? [];
  if (references.length === 0) return;

  const importLine = /^  UploadAttachmentFileBody,\r?\n/m;
  if (references.length !== 1 || !importLine.test(content)) {
    throw new Error('UploadAttachmentFileBody is no longer an unused import; review the Orval workaround');
  }

  fs.writeFileSync(HANDLERS_FILE, content.replace(importLine, ''));
  console.log('Removed unused UploadAttachmentFileBody import from handlers.ts');
}

addCustomFetchImport();
removeGeneratedServer();
removeUnusedUploadBodyImport();
