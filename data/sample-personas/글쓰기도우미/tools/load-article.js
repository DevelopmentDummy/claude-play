const fs = require('fs');
const path = require('path');

module.exports = async function(context, args) {
  var filename = args.filename;
  var docsDir = path.join(context.sessionDir, 'docs');
  var filePath = path.join(docsDir, filename);

  if (!fs.existsSync(filePath)) {
    return { result: { ok: false, message: '파일을 찾을 수 없습니다: ' + filename } };
  }

  var article = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  article.dirty = false;
  article.savedAs = filename;

  var articlePath = path.join(context.sessionDir, 'article.json');
  fs.writeFileSync(articlePath, JSON.stringify(article, null, 2), 'utf8');

  return {
    variables: {
      stage: article.stage || '대기',
      community: article.community || ''
    },
    result: { ok: true, message: '"' + (article.title || 'Untitled') + '" 불러오기 완료' }
  };
};
