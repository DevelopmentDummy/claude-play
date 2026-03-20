const fs = require('fs');
const path = require('path');

module.exports = async function(context, args) {
  var articlePath = path.join(context.sessionDir, 'article.json');
  var current = JSON.parse(fs.readFileSync(articlePath, 'utf8'));

  if (current.dirty && !args.force) {
    return { result: { ok: false, needSave: true, message: '현재 글이 수정됐습니다. 저장하시겠습니까?' } };
  }

  var blank = {
    title: "",
    body: "",
    community: current.community || "",
    tags: [],
    stage: "대기",
    dirty: false,
    notes: "",
    savedAs: ""
  };

  fs.writeFileSync(articlePath, JSON.stringify(blank, null, 2), 'utf8');

  return {
    variables: { stage: '대기' },
    result: { ok: true, message: '새 글 준비 완료' }
  };
};
