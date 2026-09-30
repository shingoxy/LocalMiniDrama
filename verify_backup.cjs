const fs = require('fs');
const path = require('path');
const Database = require('./backend-node/node_modules/better-sqlite3');
const destination = path.resolve(process.argv[2]);
const db = new Database(path.join(destination, 'backend-node/data/drama_generator.db'), { readonly: true });
try {
  const result = db.pragma('integrity_check', { simple: true });
  if (result !== 'ok') throw new Error(`SQLite integrity check: ${result}`);
  const paths = db.prepare(`
    SELECT local_path FROM image_generations UNION SELECT local_path FROM video_generations
    UNION SELECT local_path FROM characters UNION SELECT ref_image FROM characters
    UNION SELECT local_path FROM scenes UNION SELECT ref_image FROM scenes
    UNION SELECT local_path FROM props UNION SELECT ref_image FROM props
  `).all();
  for (const row of paths) {
    if (row.local_path && !fs.existsSync(path.join(destination, 'backend-node/data/storage', row.local_path))) {
      throw new Error(`Missing backed-up media: ${row.local_path}`);
    }
  }
  console.log('Backup SQLite integrity_check: ok');
} finally { db.close(); }
