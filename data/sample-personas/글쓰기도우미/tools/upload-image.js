const fs = require('fs');
const path = require('path');

module.exports = async function(context, args) {
  if (!args.data || !args.filename) {
    return { result: { ok: false, error: 'filename and data required' } };
  }

  var imagesDir = path.join(context.sessionDir, 'images');
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

  // Sanitize filename
  var ext = path.extname(args.filename).toLowerCase();
  var allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
  if (!allowed.includes(ext)) {
    return { result: { ok: false, error: 'unsupported format: ' + ext } };
  }

  var basename = path.basename(args.filename, ext)
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .substring(0, 60);
  var filename = basename + ext;

  // Avoid overwrite
  var i = 1;
  while (fs.existsSync(path.join(imagesDir, filename))) {
    filename = basename + '_' + i + ext;
    i++;
  }

  var buf = Buffer.from(args.data, 'base64');
  fs.writeFileSync(path.join(imagesDir, filename), buf);

  return { result: { ok: true, filename: filename, size: buf.length } };
};
