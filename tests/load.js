// Charge le moteur et les données sous Node.
const path = require('path');
const fs = require('fs');
for (const f of ['core', 'network', 'line', 'cabs', 'calendar', 'sim', 'econ', 'reference']) require(path.join(__dirname, '..', 'web', 'js', 'engine', f + '.js'));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'network.json'), 'utf8'));
module.exports = { TQ: globalThis.TQ, data };
