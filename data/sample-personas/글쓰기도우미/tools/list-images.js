const fs = require('fs');
const path = require('path');

module.exports = async function(context, args) {
  var imagesDir = path.join(context.sessionDir, 'images');

  if (!fs.existsSync(imagesDir)) {
    return { result: { ok: true, images: [] } };
  }

  var exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
  var files = fs.readdirSync(imagesDir).filter(function(f) {
    return exts.includes(path.extname(f).toLowerCase());
  });
  files.sort().reverse();

  var images = files.map(function(f) {
    try {
      var stat = fs.statSync(path.join(imagesDir, f));
      return {
        filename: f,
        size: stat.size,
        modified: stat.mtime.toISOString()
      };
    } catch(e) {
      return { filename: f, size: 0, modified: '' };
    }
  });

  return { result: { ok: true, images: images } };
};
