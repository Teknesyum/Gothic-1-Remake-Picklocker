const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const master = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(assets, 'icon-small.svg'), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngSizes = [32, 256, 512];

function render(win, svg, size) {
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return win.webContents.executeJavaScript(`new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = ${size}; c.height = ${size};
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, ${size}, ${size});
      ok(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = fail;
    img.src = ${JSON.stringify(url)};
  })`).then((b64) => Buffer.from(b64, 'base64'));
}

function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const images = [];
  for (const size of sizes) images.push({ size, png: await render(win, size <= 32 ? small : master, size) });
  fs.writeFileSync(path.join(assets, 'icon.ico'), ico(images));
  for (const size of pngSizes) {
    fs.writeFileSync(path.join(assets, `icon-${size}.png`), await render(win, size <= 32 ? small : master, size));
  }
  console.log('icon.ico', sizes.join(','), '+ png', pngSizes.join(','));
  app.quit();
});
