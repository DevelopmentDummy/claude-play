const fs = require('fs');
const path = require('path');

module.exports = async function(context, args) {
  var docsDir = path.join(context.sessionDir, 'docs');

  if (!fs.existsSync(docsDir)) {
    return { result: { ok: true, docs: [] } };
  }

  var files = fs.readdirSync(docsDir).filter(function(f) { return f.endsWith('.json'); });
  files.sort().reverse();

  var docs = files.map(function(f) {
    try {
      var content = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8'));
      return {
        filename: f,
        title: content.title || '(제목 없음)',
        community: content.community || '',
        stage: content.stage || ''
      };
    } catch(e) {
      return { filename: f, title: '(읽기 실패)', community: '', stage: '' };
    }
  });

  return { result: { ok: true, docs: docs } };
};
