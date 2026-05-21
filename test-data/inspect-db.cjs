const Database = require('better-sqlite3');
const db = new Database(require('os').homedir() + '/.local/share/opencode/opencode.db', {readonly: true});

// Check message data structure
const msg = db.prepare('SELECT id, session_id, data FROM message LIMIT 1').get();
if (msg && msg.data) {
  console.log('Message sample:', JSON.stringify({ id: msg.id, session_id: msg.session_id, data: JSON.parse(msg.data) }, null, 2));
}

// Check part data structure - get different types
const parts = db.prepare('SELECT id, message_id, session_id, data FROM part LIMIT 5').all();
parts.forEach((p, i) => {
  try {
    const d = JSON.parse(p.data);
    console.log('Part[' + i + '] type:', d.type, '| keys:', Object.keys(d).join(','));
  } catch {}
});

// Check session_message structure
const sm = db.prepare('SELECT * FROM session_message LIMIT 1').get();
if (sm) {
  console.log('SessionMessage keys:', Object.keys(sm).join(','));
  console.log('SessionMessage type:', sm.type);
  if (sm.data) {
    try {
      const d = JSON.parse(sm.data);
      console.log('SessionMessage data keys:', Object.keys(d).join(','));
    } catch {}
  }
}

// Count records
console.log('Sessions:', db.prepare('SELECT COUNT(*) as c FROM session').get().c);
console.log('Messages:', db.prepare('SELECT COUNT(*) as c FROM message').get().c);
console.log('Parts:', db.prepare('SELECT COUNT(*) as c FROM part').get().c);
console.log('SessionMessages:', db.prepare('SELECT COUNT(*) as c FROM session_message').get().c);

// Check distinct part types from data JSON
const partTypes = db.prepare("SELECT DISTINCT json_extract(data, '$.type') as t FROM part WHERE data IS NOT NULL LIMIT 20").all();
console.log('Part types:', partTypes.map(r => r.t));

// Check distinct session_message types
const smTypes = db.prepare("SELECT DISTINCT type FROM session_message LIMIT 20").all();
console.log('SessionMessage types:', smTypes.map(r => r.type));

db.close();
