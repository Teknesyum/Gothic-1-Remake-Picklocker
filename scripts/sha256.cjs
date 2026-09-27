const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'release');
const zips = fs.readdirSync(dir).filter((f) => f.endsWith('-win-x64.zip'));
if (!zips.length) throw new Error('release/ içinde zip yok');
for (const name of zips) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  fs.writeFileSync(path.join(dir, name + '.sha256'), `${hash}  ${name}\n`);
  console.log(hash, name);
}
