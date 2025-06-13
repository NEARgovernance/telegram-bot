import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'seen.json');

export async function loadSeen() {
  try {
    const data = await fs.readFile(FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('Error loading seen.json:', err);
    return {};
  }
}

export async function saveSeen(data) {
  try {
    await fs.writeFile(FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing seen.json:', err);
  }
}
