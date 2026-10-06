'use strict';
/**
 * Smoke tests for Focus Mode core logic (no Alexa service calls, no network).
 * Run with: cd lambda && npm test   (or: node test/smoke-test.js from the repo root)
 *
 * The tests eval the pure helper functions out of lambda/index.js by stripping
 * the requires and the skill-assembly block, then exercise them directly.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'index.js'), 'utf8');

// Strip requires + the skill-assembly block so we can eval the pure logic.
const cutAt = src.indexOf('const persistenceAdapter');
let code = src.slice(0, cutAt);
code = code.replace(/const Alexa = require\('ask-sdk-core'\);/g, 'const Alexa = {};');
code = code.replace(/const AWS = require\('aws-sdk'\);/g, 'const AWS = {};');
code = code.replace(/const \{[\s\S]*?\} = require\('ask-sdk-dynamodb-persistence-adapter'\);/g, 'const DynamoDbPersistenceAdapter = class {};');
code += `;Object.assign(globalThis, { isoDuration, parseIsoDurationMs, parseIsoTimestampMs, speakDuration, speakDurationAdj, speakDurationPrecise, speakDurationApprox, getBreakMs, buildAnnounceTimer, buildRingingTimer, freshState, reconcileState, createRoundTimers, createBreakTimer, DUR, TEST_MODE });`;
eval(code);

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- Duration formatting ---

t('isoDuration 15m', () => assert.strictEqual(isoDuration(15 * 60 * 1000), 'PT15M'));
t('isoDuration 30s', () => assert.strictEqual(isoDuration(30 * 1000), 'PT30S'));
t('isoDuration 1h', () => assert.strictEqual(isoDuration(3600 * 1000), 'PT1H'));
t('parseIsoDurationMs', () => assert.strictEqual(parseIsoDurationMs('PT18M20S'), 1100 * 1000));
t('parseIsoTimestampMs', () => assert.strictEqual(parseIsoTimestampMs(new Date(0).toISOString()), 0));
t('speakDuration minutes', () => assert.strictEqual(speakDuration(5 * 60 * 1000), '5 minutes'));
t('speakDuration seconds', () => assert.strictEqual(speakDuration(30 * 1000), '30 seconds'));
t('speakDurationAdj attributive', () => assert.strictEqual(speakDurationAdj(5 * 60 * 1000), '5 minute'));
t('speakDurationPrecise', () => assert.strictEqual(speakDurationPrecise(740 * 1000), '12 minutes and 20 seconds'));

// --- Break alternation ---

t('break after odd round = 5m', () => assert.strictEqual(getBreakMs(1), 5 * 60 * 1000));
t('break after even round = 10m', () => assert.strictEqual(getBreakMs(2), 10 * 60 * 1000));
t('break after round 7 = 5m', () => assert.strictEqual(getBreakMs(7), 5 * 60 * 1000));

// --- Timer request shapes (Timers REST API contract) ---

t('announce timer shape', () => {
  const r = buildAnnounceTimer('Focus halfway', 900000, 'hello');
  assert.strictEqual(r.duration, 'PT15M');
  assert.strictEqual(r.triggeringBehavior.operation.type, 'ANNOUNCE');
  assert.strictEqual(r.triggeringBehavior.notificationConfig.playAudible, false);
  assert.strictEqual(r.triggeringBehavior.operation.textToAnnounce[0].locale, 'en-US');
  assert.strictEqual(r.creationBehavior.displayExperience.visibility, 'VISIBLE');
});
t('ringing timer shape', () => {
  const r = buildRingingTimer('Focus break', 2100000);
  assert.strictEqual(r.triggeringBehavior.operation.type, 'NOTIFY_ONLY');
  assert.strictEqual(r.triggeringBehavior.notificationConfig.playAudible, true);
});

// --- Production guardrails ---

t('production durations active', () => {
  assert.strictEqual(DUR.focusMs, 30 * 60 * 1000);
  assert.strictEqual(DUR.halfwayMs, 15 * 60 * 1000);
  assert.strictEqual(DUR.fiveLeftMs, 25 * 60 * 1000);
  assert.strictEqual(TEST_MODE, false, 'TEST_MODE must ship false');
});

// --- State reconciliation ---

t('reconcile focus->break', () => {
  const state = freshState();
  state.status = 'focus'; state.roundNumber = 1;
  state.plannedFocusEnd = Date.now() - 1000;
  state.plannedBreakEnd = Date.now() + 5 * 60 * 1000;
  assert.strictEqual(reconcileState(state, new Map()).status, 'break');
});
t('reconcile focus->waiting', () => {
  const state = freshState();
  state.status = 'focus'; state.roundNumber = 1;
  state.plannedFocusEnd = Date.now() - 600000;
  state.plannedBreakEnd = Date.now() - 1000;
  assert.strictEqual(reconcileState(state, new Map()).status, 'waiting');
});
t('reconcile break->waiting', () => {
  const state = freshState();
  state.status = 'break'; state.roundNumber = 1;
  state.plannedBreakEnd = Date.now() - 1000;
  assert.strictEqual(reconcileState(state, new Map()).status, 'waiting');
});
t('reconcile pausedFocus + missing timer -> waiting', () => {
  const state = freshState();
  state.status = 'pausedFocus'; state.roundNumber = 3;
  state.timerIds = { focusEnd: 'gone' };
  assert.strictEqual(reconcileState(state, new Map()).status, 'waiting');
});
t('reconcile pausedFocus + PAUSED timer stays paused', () => {
  const state = freshState();
  state.status = 'pausedFocus'; state.roundNumber = 3;
  state.timerIds = { focusEnd: 't1' };
  const timers = new Map([['t1', { id: 't1', status: 'PAUSED' }]]);
  assert.strictEqual(reconcileState(state, timers).status, 'pausedFocus');
});
t('reconcile stale waiting resets to idle', () => {
  const state = freshState();
  state.status = 'waiting'; state.roundNumber = 2;
  state.updatedAt = Date.now() - 13 * 60 * 60 * 1000; // older than 12h
  assert.strictEqual(reconcileState(state, new Map()).status, 'idle');
});
t('reconcile fresh waiting stays', () => {
  const state = freshState();
  state.status = 'waiting'; state.roundNumber = 2;
  state.updatedAt = Date.now();
  assert.strictEqual(reconcileState(state, new Map()).status, 'waiting');
});

// --- Timer creation + atomic rollback (with a fake Timers API client) ---

function makeClient(failOnCall) {
  let n = 0;
  const deleted = [];
  return {
    deleted,
    callCreateTimer: async () => {
      n += 1;
      if (failOnCall === n) return { statusCode: 403, body: JSON.stringify({ code: 'MAX_TIMERS_EXCEEDED' }) };
      return { statusCode: 200, body: JSON.stringify({ id: `timer-${n}`, triggerTime: null }) };
    },
    callDeleteTimer: async (id) => { deleted.push(id); return { statusCode: 200 }; },
  };
}

(async () => {
  let asyncPassed = 0;
  const a = (name, fn) => {
    try { fn(); asyncPassed++; } catch (e) {
      console.error(`FAIL: ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };

  const res = await createRoundTimers(makeClient(), 3);
  a('createRoundTimers returns 4 ids', () => assert.strictEqual(Object.keys(res.timerIds).length, 4));
  a('planned times ordered', () => {
    assert(res.plannedTimes.breakEnd > res.plannedTimes.focusEnd);
    assert(res.plannedTimes.focusEnd > res.plannedTimes.fiveLeft);
    assert(res.plannedTimes.fiveLeft > res.plannedTimes.halfway);
  });
  a('round 3 has a 5 minute break (odd round)', () => {
    assert.strictEqual(res.breakMs, 5 * 60 * 1000);
  });

  const client2 = makeClient(3);
  let threw = false;
  try { await createRoundTimers(client2, 3); } catch (e) {
    threw = true;
    a('error code surfaced', () => assert.strictEqual(e.code, 'MAX_TIMERS_EXCEEDED'));
  }
  a('rollback throws on partial failure', () => assert(threw, 'should throw'));
  a('rollback deletes 2 created timers', () => assert.strictEqual(client2.deleted.length, 2));

  console.log(`${passed + asyncPassed} smoke tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
})();


