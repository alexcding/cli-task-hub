// The Tickets search box accepts keywords, a ticket key, or raw JQL (src/shared/jql.mjs).
const { test } = require('node:test');
const assert = require('node:assert');

test('toJql: keywords become a project-scoped text search', async () => {
  const { toJql } = await import('../src/shared/jql.mjs');
  assert.equal(toJql('login crash', 'REC'), 'project = REC AND text ~ "login crash" ORDER BY updated DESC');
  assert.equal(toJql('  order   status ', ''), 'text ~ "order status" ORDER BY updated DESC');
  assert.equal(toJql('say "hi"', 'REC'), 'project = REC AND text ~ "say hi" ORDER BY updated DESC');
  assert.equal(toJql('', 'REC'), '');
});

test('toJql: a ticket key looks up that ticket, raw JQL passes through unscoped', async () => {
  const { toJql } = await import('../src/shared/jql.mjs');
  assert.equal(toJql('rec-42', 'REC'), 'key = REC-42');
  assert.equal(toJql('assignee = currentUser() AND status != Done', 'REC'), 'assignee = currentUser() AND status != Done');
  assert.equal(toJql('status in (Open, "In Progress")', 'REC'), 'status in (Open, "In Progress")');
  assert.equal(toJql('summary ~ login order by created', 'REC'), 'summary ~ login order by created');
});

test('toJql: English phrases containing and/or/not/in/is stay keyword searches', async () => {
  const { toJql, looksLikeJql } = await import('../src/shared/jql.mjs');
  for (const s of ['not working', 'log in crash', 'cannot log in', 'video is black', 'ios or android', 'sign in and out']) {
    assert.equal(looksLikeJql(s), false, s);
    assert.equal(toJql(s, 'REC'), `project = REC AND text ~ "${s}" ORDER BY updated DESC`);
  }
  for (const s of ['status in (Open, Done)', 'assignee is EMPTY', 'status was "In Progress"', 'status not in (Done)', 'labels is not empty', 'order by created']) {
    assert.equal(looksLikeJql(s), true, s);
  }
});
