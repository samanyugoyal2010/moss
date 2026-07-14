const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'nodes', 'Moss');
const destDir = path.join(__dirname, '..', 'dist', 'nodes', 'Moss');

fs.mkdirSync(destDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
	if (file.endsWith('.svg') || file.endsWith('.png') || file.endsWith('.json')) {
		fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
	}
}

console.log('Copied Moss node icons and metadata');
