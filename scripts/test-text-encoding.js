'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fixtures = [
  {
    file: 'src/server/public/index.html',
    expected: [
      '<meta charset="utf-8">',
      '只研究净买入资金',
      '毕业前，当净买入资金',
      'T−6 → T−4',
      '今日 Raw Trades',
      '止盈 (%)',
      '实盘入场',
      '毕业后独立深跌反弹周期',
    ],
  },
  {
    file: 'README.md',
    expected: ['多策略实盘框架', 'false → true', '可复现分析', 'W3≥8/10'],
  },
  {
    file: '.env.example',
    expected: ['— research only'],
  },
];

for (const fixture of fixtures) {
  const text = fs.readFileSync(path.join(root, fixture.file), 'utf8');
  assert.ok(!text.includes('\uFFFD'), `${fixture.file} contains a Unicode replacement character`);
  assert.ok(!/\?{3,}/.test(text), `${fixture.file} contains a suspicious question-mark run`);
  for (const expected of fixture.expected) {
    assert.ok(text.includes(expected), `${fixture.file} is missing UTF-8 sentinel: ${expected}`);
  }
}

console.log('test-text-encoding: ok');
