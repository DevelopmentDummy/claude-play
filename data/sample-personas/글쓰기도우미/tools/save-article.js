const fs = require('fs');
const path = require('path');

module.exports = async function(context, args) {
  const articlePath = path.join(context.sessionDir, 'article.json');
  const docsDir = path.join(context.sessionDir, 'docs');

  const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));

  if (!article.title && !article.body) {
    return { result: { ok: false, message: '저장할 내용이 없습니다.' } };
  }

  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const comm = (article.community || 'misc').replace(/[^a-zA-Z가-힣ㄱ-ㅎ0-9]/g, '').slice(0, 10);
  const ttl = (article.title || 'untitled').replace(/[^a-zA-Z가-힣ㄱ-ㅎ0-9]/g, '-').slice(0, 15);
  const filename = date + '_' + comm + '_' + ttl + '.json';

  fs.writeFileSync(path.join(docsDir, filename), JSON.stringify(article, null, 2), 'utf8');

  const docCount = fs.readdirSync(docsDir).filter(function(f) { return f.endsWith('.json'); }).length;

  return {
    variables: { doc_count: docCount },
    data: { "article.json": { dirty: false, savedAs: filename } },
    result: { ok: true, filename: filename, message: '"' + (article.title || 'Untitled') + '" 저장 완료' }
  };
};
