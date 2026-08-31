'use strict';
/**
 * Focus Mode — a Pomodoro-style custom Alexa skill built on the Alexa Timers API.
 *
 * Architecture: every 30-minute focus round pre-schedules four Alexa timers while
 * the skill session is active (the Timers REST API only allows create/pause/resume
 * with an IN-SESSION apiAccessToken — see the Timers REST API reference). Alexa's
 * timer infrastructure fires the events on the device; this Lambda does NOT stay
 * running between invocations.
 *
 *   Timer A (+15m)  ANNOUNCE, playAudible=false  -> Alexa SPEAKS the checkpoint.
 *   Timer B (+25m)  ANNOUNCE, playAudible=false  -> Alexa SPEAKS the warning.
 *   Timer C (+30m)  ANNOUNCE, playAudible=false  -> focus complete / break starts.
 *   Timer D (+30m+break) NOTIFY_ONLY, playAudible=true -> rings until dismissed.
 *
 * Verified behaviors (Alexa "Timers REST API Reference", updated 2024-08-07, and
 * "Understand Alexa Timers", updated 2025-10-30):
 *   - ANNOUNCE + playAudible=false: "Alexa speaks the text when the timer
 *     expires." (No ringing, nothing to dismiss.)
 *   - NOTIFY_ONLY requires playAudible=true: Alexa "plays the notification
 *     until the user says 'Alexa, stop'" (or dismisses it on the device).
 *   - Announcement text is PLAIN TEXT ONLY (no SSML) and Alexa automatically
 *     prefixes it with "from <skill name>" (cannot be removed).
 *   - Max timer duration: 2 hours. Max skill timers: 25 (403 MAX_TIMERS_EXCEEDED).
 *   - Timer statuses: ON | PAUSED | OFF. Pause only from ON
 *     (TIMER_ALREADY_PAUSED); resume only from PAUSED (TIMER_IS_NOT_PAUSED).
 *   - A skill can only ever see/modify timers IT created (enforced by Alexa).
 */

const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const { DynamoDbPersistenceAdapter } = require('ask-sdk-dynamodb-persistence-adapter');

// ===========================================================================
// ⚙️⚙️⚙️  TEST MODE SWITCH — PRODUCTION DEFAULTS ARE MINUTES. ⚙️⚙️⚙️
//
// Set TEST_MODE = true ONLY while developing/testing, then set it back to
// false and click "Deploy" before real use. Production MUST remain minutes.
// ===========================================================================
const TEST_MODE = false; // <-- true = durations are in SECONDS below

const PRODUCTION_DURATIONS = {
  focusMs: 30 * 60 * 1000,        // 30-minute focus round
  halfwayMs: 15 * 60 * 1000,      // +15m checkpoint
  fiveLeftMs: 25 * 60 * 1000,     // +25m warning
  breakOddMs: 5 * 60 * 1000,      // break after ODD rounds
  breakEvenMs: 10 * 60 * 1000,    // break after EVEN rounds
};

// Development-only: same structure, seconds instead of minutes.
const TEST_DURATIONS = {
  focusMs: 30 * 1000,             // 30-second focus "round"
  halfwayMs: 15 * 1000,           // +15s checkpoint
  fiveLeftMs: 25 * 1000,          // +25s warning
  breakOddMs: 5 * 1000,           // 5-second break
  breakEvenMs: 10 * 1000,         // 10-second break
};

const DUR = TEST_MODE ? TEST_DURATIONS : PRODUCTION_DURATIONS;

const TIMERS_PERMISSION_SCOPE = 'alexa::alerts:timers:skill:readwrite';
const SKILL_DISPLAY_NAME = 'Focus Mode';
const LOCALE = 'en-US';
const STATE_KEY = 'focusMode';

// Timer labels (Alexa guideline: short, <= 3 words, in device language).
// Uniqueness across sessions is enforced by tracking timer IDs in DynamoDB,
// NOT by the label.
const TIMER_LABELS = {
  halfway: 'Focus halfway',
  fiveLeft: 'Five left',
  focusEnd: 'Focus end',
  breakEnd: 'Focus break',
};

// A session with no live timers is considered stale and reset to idle.
const STALE_ACTIVE_MS = 24 * 60 * 60 * 1000;   // focus/break/paused states
const STALE_WAITING_MS = 12 * 60 * 60 * 1000;  // waiting-for-next-round state


// ---------------------------------------------------------------------------
// Small formatting / time helpers
// ---------------------------------------------------------------------------

/** Convert milliseconds to an ISO-8601 duration string, e.g. 900000 -> "PT15M". */
function isoDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let out = 'PT';
  if (hours) out += `${hours}H`;
  if (minutes) out += `${minutes}M`;
  if (seconds) out += `${seconds}S`;
  return out === 'PT' ? 'PT1S' : out;
}

/** Parse an ISO-8601 duration like "PT18M20S" into milliseconds (or null). */
function parseIsoDurationMs(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return ((+(d || 0) * 86400) + (+(h || 0) * 3600) + (+(min || 0) * 60) + +(s || 0)) * 1000;
}

/** Parse an ISO-8601 timestamp into epoch ms (or null). */
function parseIsoTimestampMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "5 minutes" / "30 seconds" — plain text Alexa reads naturally. */
function speakDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds >= 60) {
    const m = Math.round(totalSeconds / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
}

/** "12 minutes and 20 seconds" for precise status readouts. */
function speakDurationPrecise(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0 && s > 0) return `${m} minutes and ${s} seconds`;
  if (m > 0) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${s} second${s === 1 ? '' : 's'}`;
}

/** "about 18 minutes" for approximate readouts. */
function speakDurationApprox(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Attributive form: "5 minute break" / "10 second break" (no plural). */
function speakDurationAdj(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds >= 60) {
    const m = Math.round(totalSeconds / 60);
    return `${m} minute`;
  }
  return `${totalSeconds} second`;
}

/** Break length after a given round: odd = 5 min, even = 10 min. */
function getBreakMs(roundNumber) {
  return roundNumber % 2 === 1 ? DUR.breakOddMs : DUR.breakEvenMs;
}


// ---------------------------------------------------------------------------
// Timer API helpers (Alexa Timers REST API via the ASK SDK's
// TimerManagementServiceClient — handlerInput.serviceClientFactory)
// ---------------------------------------------------------------------------

/**
 * Returns the Timers service client, or null if this request cannot use it
 * (e.g. availability checks carry no real session/token).
 */
function getTimerClient(handlerInput) {
  const system = handlerInput.requestEnvelope.context
    && handlerInput.requestEnvelope.context.System;
  if (!system || !system.apiAccessToken || !system.apiEndpoint) return null;
  try {
    return handlerInput.serviceClientFactory.getTimerManagementServiceClient();
  } catch (err) {
    console.error('getTimerManagementServiceClient failed:', err && err.message);
    return null;
  }
}

/**
 * True when the user has granted the timers permission for this skill.
 * A list-timers call is the cheapest read: 200 = consented, 401/403 = not.
 */
async function hasTimerPermission(client) {
  try {
    const resp = await client.callGetTimers();
    return !!(resp && resp.statusCode === 200);
  } catch (err) {
    console.error('callGetTimers failed:', err && err.message);
    return false;
  }
}

/**
 * Fetch all timers created by this skill as a Map<timerId, timerObject>.
 * Returns an empty Map on failure (never fatal — see reconcileState).
 */
async function listMyTimers(client) {
  const map = new Map();
  try {
    const resp = await client.callGetTimers();
    if (resp && resp.statusCode === 200 && resp.body) {
      const parsed = JSON.parse(resp.body);
      for (const t of parsed.timers || []) {
        if (t && t.id) map.set(t.id, t);
      }
    } else {
      console.warn('listMyTimers non-200:', resp && resp.statusCode);
    }
  } catch (err) {
    console.warn('listMyTimers failed (continuing):', err && err.message);
  }
  return map;
}

/**
 * Create one timer. Returns the parsed timer object (with .id) on HTTP 200,
 * otherwise throws an Error carrying the API error code (e.g.
 * MAX_TIMERS_EXCEEDED, INVALID_DURATION_FORMAT).
 */
async function createTimer(client, timerRequest) {
  const resp = await client.callCreateTimer(timerRequest);
  if (!resp || resp.statusCode !== 200 || !resp.body) {
    let code = 'UNKNOWN';
    let message = `HTTP ${resp ? resp.statusCode : 'no response'}`;
    if (resp && resp.body) {
      try {
        const parsed = JSON.parse(resp.body);
        code = parsed.code || code;
        message = parsed.message || message;
      } catch (e) { /* body was not JSON */ }
    }
    const err = new Error(`Timer create failed: ${code} ${message}`);
    err.code = code;
    throw err;
  }
  return JSON.parse(resp.body);
}

/** Fetch one timer by ID (parsed body) or null if missing/expired. */
async function getTimerSafe(client, timerId) {
  if (!timerId) return null;
  try {
    const resp = await client.callGetTimer(timerId);
    if (resp && resp.statusCode === 200 && resp.body) return JSON.parse(resp.body);
    return null;
  } catch (err) {
    console.warn(`getTimer ${timerId} failed (ignored):`, err && err.message);
    return null;
  }
}


/**
 * Delete one timer by ID. Never throws: missing/expired timers (404) are
 * fine. Only ever called with timer IDs tracked by THIS skill's session
 * state, so manually created timers are never touched.
 */
async function deleteTimerSafe(client, timerId) {
  if (!timerId) return;
  try {
    const resp = await client.callDeleteTimer(timerId);
    console.log(`deleteTimer ${timerId} -> ${resp ? resp.statusCode : 'error'}`);
  } catch (err) {
    console.warn(`deleteTimer ${timerId} failed (ignored):`, err && err.message);
  }
}

/**
 * Pause one timer. Returns 'paused' | 'alreadyPaused' | 'notFound' | 'failed'.
 * Only timers with status ON can be paused (TIMER_ALREADY_PAUSED otherwise).
 */
async function pauseTimerSafe(client, timerId) {
  if (!timerId) return 'notFound';
  try {
    const resp = await client.callPauseTimer(timerId);
    if (resp && resp.statusCode === 200) {
      console.log(`pauseTimer ${timerId} -> 200`);
      return 'paused';
    }
    if (resp && resp.body && String(resp.body).includes('TIMER_ALREADY_PAUSED')) {
      return 'alreadyPaused';
    }
    console.warn(`pauseTimer ${timerId} -> ${resp ? resp.statusCode : 'error'}`);
    return 'failed';
  } catch (err) {
    const msg = (err && err.message) || '';
    if (msg.includes('TIMER_ALREADY_PAUSED')) return 'alreadyPaused';
    console.warn(`pauseTimer ${timerId} failed:`, msg);
    return 'failed';
  }
}

/**
 * Resume one timer. Returns 'resumed' | 'notPaused' | 'notFound' | 'failed'.
 * Only timers with status PAUSED can be resumed (TIMER_IS_NOT_PAUSED else).
 */
async function resumeTimerSafe(client, timerId) {
  if (!timerId) return 'notFound';
  try {
    const resp = await client.callResumeTimer(timerId);
    if (resp && resp.statusCode === 200) {
      console.log(`resumeTimer ${timerId} -> 200`);
      return 'resumed';
    }
    if (resp && resp.body && String(resp.body).includes('TIMER_IS_NOT_PAUSED')) {
      return 'notPaused';
    }
    console.warn(`resumeTimer ${timerId} -> ${resp ? resp.statusCode : 'error'}`);
    return 'failed';
  } catch (err) {
    const msg = (err && err.message) || '';
    if (msg.includes('TIMER_IS_NOT_PAUSED')) return 'notPaused';
    console.warn(`resumeTimer ${timerId} failed:`, msg);
    return 'failed';
  }
}


// ---------------------------------------------------------------------------
// Persistent state (DynamoDB via the SDK persistence adapter; one item per
// Alexa user ID — no hardware identifiers are ever used or needed)
// ---------------------------------------------------------------------------

/** A brand-new idle session state. */
function freshState() {
  return {
    status: 'idle',            // idle | focus | break | waiting | pausedFocus | pausedBreak
    roundNumber: 0,
    breakMs: null,             // length of the current/upcoming break in ms
    timerIds: {},              // { halfway, fiveLeft, focusEnd, breakEnd }
    focusStartedAt: null,      // epoch ms
    plannedFocusEnd: null,     // epoch ms
    plannedBreakEnd: null,     // epoch ms
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function loadState(handlerInput) {
  try {
    const attrs = await handlerInput.attributesManager.getPersistentAttributes();
    const state = attrs[STATE_KEY];
    if (!state || typeof state !== 'object') return freshState();
    // Backfill any missing fields so older state shapes never crash handlers.
    return Object.assign(freshState(), state);
  } catch (err) {
    console.warn('loadState failed (treating as idle):', err && err.message);
    return freshState();
  }
}

async function saveState(handlerInput, state) {
  state.updatedAt = Date.now();
  try {
    const attrs = handlerInput.attributesManager.getPersistentAttributes();
    attrs[STATE_KEY] = state;
    handlerInput.attributesManager.setPersistentAttributes(attrs);
    await handlerInput.attributesManager.savePersistentAttributes();
  } catch (err) {
    console.error('saveState failed:', err && err.message);
  }
}

/** Reset to a clean idle state (round counter restarts at 1 next time). */
async function clearState(handlerInput) {
  await saveState(handlerInput, freshState());
}

// ---------------------------------------------------------------------------
// Timer request builders
// ---------------------------------------------------------------------------

/**
 * An ANNOUNCE timer with playAudible=false: per the Timers API docs, Alexa
 * SPEAKS textToAnnounce when the timer expires (no ringing, nothing to
 * dismiss). Text must be plain text (SSML is not supported) and Alexa
 * automatically prefixes it with "from Focus Mode".
 */
function buildAnnounceTimer(label, delayMs, text) {
  return {
    duration: isoDuration(delayMs),
    timerLabel: label,
    creationBehavior: { displayExperience: { visibility: 'VISIBLE' } },
    triggeringBehavior: {
      operation: {
        type: 'ANNOUNCE',
        textToAnnounce: [{ locale: LOCALE, text }],
      },
      notificationConfig: { playAudible: false },
    },
  };
}

/**
 * A normal ringing timer (NOTIFY_ONLY + playAudible=true): Alexa plays the
 * notification "until the user says 'Alexa, stop'" or dismisses it on the
 * device (e.g. tapping the top of an Echo Dot). Used ONLY for break end.
 */
function buildRingingTimer(label, delayMs) {
  return {
    duration: isoDuration(delayMs),
    timerLabel: label,
    creationBehavior: { displayExperience: { visibility: 'VISIBLE' } },
    triggeringBehavior: {
      operation: { type: 'NOTIFY_ONLY' },
      notificationConfig: { playAudible: true },
    },
  };
}


/**
 * Create all four timers for a focus round, atomically: if any creation
 * fails, every timer already created for this attempt is deleted so we never
 * leave a broken half-scheduled round behind.
 */
async function createRoundTimers(client, roundNumber) {
  const breakMs = getBreakMs(roundNumber);
  const focusText = `Round ${roundNumber} is starting now. Focus for ${speakDuration(DUR.focusMs)}. `
    + `I'll check in halfway and again when you have ${speakDuration(DUR.focusMs - DUR.fiveLeftMs)} left.`;
  const halfwayText = `You're halfway through round ${roundNumber}. ${speakDuration(DUR.focusMs - DUR.halfwayMs)} left.`;
  const fiveLeftText = `Nice work. ${speakDuration(DUR.focusMs - DUR.fiveLeftMs)} left in round ${roundNumber}.`;
  const focusEndText = `Nice work. Round ${roundNumber} is complete. Your ${speakDurationAdj(breakMs)} break starts now.`;

  const specs = [
    { key: 'halfway', delayMs: DUR.halfwayMs, request: buildAnnounceTimer(TIMER_LABELS.halfway, DUR.halfwayMs, halfwayText) },
    { key: 'fiveLeft', delayMs: DUR.fiveLeftMs, request: buildAnnounceTimer(TIMER_LABELS.fiveLeft, DUR.fiveLeftMs, fiveLeftText) },
    { key: 'focusEnd', delayMs: DUR.focusMs, request: buildAnnounceTimer(TIMER_LABELS.focusEnd, DUR.focusMs, focusEndText) },
    { key: 'breakEnd', delayMs: DUR.focusMs + breakMs, request: buildRingingTimer(TIMER_LABELS.breakEnd, DUR.focusMs + breakMs) },
  ];

  const created = [];
  const timerIds = {};
  try {
    for (const spec of specs) {
      const timer = await createTimer(client, spec.request);
      console.log(`created timer ${spec.key}: ${timer.id}`);
      timerIds[spec.key] = timer.id;
      created.push(timer);
    }
    const now = Date.now();
    return {
      timerIds,
      // Prefer Alexa's own triggerTime as the source of truth; fall back to
      // local wall-clock arithmetic if a triggerTime is missing.
      plannedTimes: {
        halfway: parseIsoTimestampMs(created[0].triggerTime) || now + DUR.halfwayMs,
        fiveLeft: parseIsoTimestampMs(created[1].triggerTime) || now + DUR.fiveLeftMs,
        focusEnd: parseIsoTimestampMs(created[2].triggerTime) || now + DUR.focusMs,
        breakEnd: parseIsoTimestampMs(created[3].triggerTime) || now + DUR.focusMs + breakMs,
      },
      focusEndText,
      breakMs,
    };
  } catch (err) {
    // Roll back the timers this attempt already created.
    console.error('createRoundTimers partial failure:', err.message);
    for (const id of Object.values(timerIds)) {
      await deleteTimerSafe(client, id);
    }
    throw err;
  }
}

/** Create a single break-end ringing timer starting NOW. */
async function createBreakTimer(client, breakMs) {
  const timer = await createTimer(client, buildRingingTimer(TIMER_LABELS.breakEnd, breakMs));
  return {
    timerIds: { breakEnd: timer.id },
    plannedBreakEnd: parseIsoTimestampMs(timer.triggerTime) || Date.now() + breakMs,
  };
}

/** Delete every tracked timer of the current session (individually, safely). */
async function cancelTrackedTimers(client, state, keys) {
  const toDelete = keys || Object.keys(state.timerIds || {});
  for (const key of toDelete) {
    await deleteTimerSafe(client, state.timerIds ? state.timerIds[key] : undefined);
  }
}


// ---------------------------------------------------------------------------
// State reconciliation
// ---------------------------------------------------------------------------

/**
 * Bring stored state in line with reality before handling any command.
 *
 * The skill receives NO callback when a plain timer expires or when the user
 * dismisses a ringing timer, so wall-clock timestamps (seeded from Alexa's
 * own triggerTime values at creation time) are reconciled on every
 * invocation. PAUSED states are the exception: wall clock is meaningless
 * while paused, so the Timers API status is the source of truth there.
 *
 * "Timer not found" is never fatal — expired timers simply vanish from the
 * API results, which is exactly what the transition logic expects.
 */
function reconcileState(state, timersMap) {
  if (!state || state.status === 'idle') return state;
  const now = Date.now();

  const live = {};
  for (const [key, id] of Object.entries(state.timerIds || {})) {
    if (id && timersMap && timersMap.has(id)) live[key] = timersMap.get(id);
  }

  switch (state.status) {
    case 'focus':
      // Past focus end but inside the break window -> we are on break now.
      if (now >= state.plannedFocusEnd) {
        state.status = state.plannedBreakEnd && now < state.plannedBreakEnd ? 'break' : 'waiting';
      }
      break;
    case 'break':
      if (now >= state.plannedBreakEnd) state.status = 'waiting';
      break;
    case 'pausedFocus': {
      // Only the Timer API is trustworthy while paused.
      const t = live.focusEnd;
      if (!t || t.status === 'OFF') state.status = 'waiting';
      else if (t.status === 'ON') state.status = 'focus'; // resumed externally
      break;
    }
    case 'pausedBreak': {
      const t = live.breakEnd;
      if (!t || t.status === 'OFF') state.status = 'waiting';
      else if (t.status === 'ON') state.status = 'break';
      break;
    }
    default:
      break;
  }

  // Stale-session safety net: if a session looks old AND none of its timers
  // are live any more, reset to idle instead of resuming something ancient.
  const age = now - (state.updatedAt || state.createdAt || now);
  const threshold = state.status === 'waiting' ? STALE_WAITING_MS : STALE_ACTIVE_MS;
  const isActiveState = ['focus', 'break', 'pausedFocus', 'pausedBreak', 'waiting'].includes(state.status);
  if (isActiveState && age > threshold && Object.keys(live).length === 0) {
    console.warn('Stale Focus Mode session detected; resetting to idle.');
    return freshState();
  }
  return state;
}

/** Remaining focus time in ms, preferring the Timer API's focusEnd timer. */
async function getRemainingFocusMs(client, state) {
  const t = await getTimerSafe(client, state.timerIds && state.timerIds.focusEnd);
  if (t && t.status === 'ON' && t.triggerTime) {
    const remaining = parseIsoTimestampMs(t.triggerTime) - Date.now();
    if (remaining > 0) return remaining;
  }
  if (t && t.status === 'PAUSED' && t.remainingTimeWhenPaused) {
    return parseIsoDurationMs(t.remainingTimeWhenPaused) || 0;
  }
  if (state.status === 'pausedFocus') return 0;
  return Math.max(0, (state.plannedFocusEnd || 0) - Date.now());
}

/** Remaining break time in ms, preferring the Timer API's breakEnd timer. */
async function getRemainingBreakMs(client, state) {
  const t = await getTimerSafe(client, state.timerIds && state.timerIds.breakEnd);
  if (t && t.status === 'ON' && t.triggerTime) {
    const remaining = parseIsoTimestampMs(t.triggerTime) - Date.now();
    if (remaining > 0) return remaining;
  }
  if (t && t.status === 'PAUSED' && t.remainingTimeWhenPaused) {
    return parseIsoDurationMs(t.remainingTimeWhenPaused) || 0;
  }
  return Math.max(0, (state.plannedBreakEnd || 0) - Date.now());
}


// ---------------------------------------------------------------------------
// Speech + permission helpers
// ---------------------------------------------------------------------------

/** Speak text and close the session (Focus Mode never needs to stay open). */
function say(handlerInput, text) {
  return handlerInput.responseBuilder
    .speak(text)
    .withShouldEndSession(true)
    .getResponse();
}

/**
 * Kick off the official Alexa voice-permission flow (Connections.SendRequest
 * with AskForPermissionsConsentRequest v2). Alexa asks the user on the
 * device; the skill receives a Connections.Response with the outcome and we
 * continue the original action directly on ACCEPTED via the token below.
 */
function requestTimerPermission(handlerInput, token) {
  return handlerInput.responseBuilder
    .speak(`I need permission to set timers for you. I'll ask now — just say yes.`)
    .addDirective({
      type: 'Connections.SendRequest',
      name: 'AskFor',
      payload: {
        '@type': 'AskForPermissionsConsentRequest',
        '@version': '2',
        permissionScopes: [
          {
            permissionScope: TIMERS_PERMISSION_SCOPE,
            consentLevel: 'ACCOUNT',
          },
        ],
      },
      token,
    })
    .getResponse();
}

// ---------------------------------------------------------------------------
// Core feature functions (shared by intents / launch / permission callback)
// ---------------------------------------------------------------------------

/** Gate: return a timer client + reconciled state, or an error marker. */
async function getContext(handlerInput) {
  const client = getTimerClient(handlerInput);
  if (!client) {
    return {
      error: true,
      response: say(handlerInput, "Sorry, I can't manage timers from this request. Try again from your Echo."),
    };
  }
  if (!(await hasTimerPermission(client))) {
    return { error: true, permissionNeeded: true };
  }
  let state = await loadState(handlerInput);
  const timersMap = await listMyTimers(client);
  const before = state.status;
  state = reconcileState(state, timersMap);
  if (state.status !== before) {
    console.log(`reconcileState: ${before} -> ${state.status}`);
    await saveState(handlerInput, state);
  }
  return { client, state, timersMap };
}

/** Standardized entry for intents: handles permission gating, then runs fn. */
async function withContext(handlerInput, token, fn) {
  const ctx = await getContext(handlerInput);
  if (ctx.error) {
    if (ctx.permissionNeeded) return requestTimerPermission(handlerInput, token);
    return ctx.response;
  }
  try {
    return await fn(handlerInput, ctx.client, ctx.state, ctx.timersMap);
  } catch (err) {
    console.error('Intent handling error:', err && err.message);
    return say(handlerInput, `Sorry, something went wrong. Please try again.`);
  }
}







/** Begin a brand-new Focus Mode session at Round 1 (must be idle). */
async function startNewSession(handlerInput, client, state) {
  // Clean up any leftover timers from an old session before starting fresh.
  await cancelTrackedTimers(client, state);
  try {
    const round = 1;
    const result = await createRoundTimers(client, round);
    const newState = freshState();
    newState.status = 'focus';
    newState.roundNumber = round;
    newState.breakMs = result.breakMs;
    newState.timerIds = result.timerIds;
    newState.focusStartedAt = Date.now();
    newState.plannedFocusEnd = result.plannedTimes.focusEnd;
    newState.plannedBreakEnd = result.plannedTimes.breakEnd;
    await saveState(handlerInput, newState);
    return say(handlerInput, result.focusEndText);
  } catch (err) {
    console.error('startNewSession failed:', err.message);
    if (err.code === 'MAX_TIMERS_EXCEEDED') {
      return say(handlerInput, `I couldn't set the timers because there are too many timers on this device. Remove the ones you don't need, then start again.`);
    }
    return say(handlerInput, `Sorry, something went wrong while setting up Focus Mode. Please try again.`);
  }
}

/** Start the next numbered round (used by resume-when-waiting / next round). */
async function startNextRound(handlerInput, client, state) {
  const round = (state.roundNumber || 0) + 1;
  await cancelTrackedTimers(client, state);
  try {
    const result = await createRoundTimers(client, round);
    const newState = freshState();
    newState.status = 'focus';
    newState.roundNumber = round;
    newState.breakMs = result.breakMs;
    newState.timerIds = result.timerIds;
    newState.focusStartedAt = Date.now();
    newState.plannedFocusEnd = result.plannedTimes.focusEnd;
    newState.plannedBreakEnd = result.plannedTimes.breakEnd;
    await saveState(handlerInput, newState);
    return say(handlerInput, result.focusEndText);
  } catch (err) {
    console.error('startNextRound failed:', err.message);
    if (err.code === 'MAX_TIMERS_EXCEEDED') {
      return say(handlerInput, `I couldn't set the timers because there are too many timers on this device. Remove the ones you don't need, then try again.`);
    }
    return say(handlerInput, `Sorry, something went wrong while starting round ${round}. Please try again.`);
  }
}

/** START — only from idle (duplicate starts are politely declined). */
async function doStart(handlerInput, client, state) {
  switch (state.status) {
    case 'idle':
      return startNewSession(handlerInput, client, state);
    case 'waiting':
      // "start" while waiting behaves like "next round" — most natural UX.
      return startNextRound(handlerInput, client, state);
    case 'focus': {
      const remaining = await getRemainingFocusMs(client, state);
      return say(handlerInput, `Focus Mode is already running. You have ${speakDurationApprox(remaining)} left in round ${state.roundNumber}.`);
    }
    case 'break': {
      const remaining = await getRemainingBreakMs(client, state);
      return say(handlerInput, `You're on your break with ${speakDurationApprox(remaining)} left. Say next round to start round ${state.roundNumber + 1} early.`);
    }
    case 'pausedFocus':
      return say(handlerInput, `Focus Mode is paused in round ${state.roundNumber}. Say resume to continue.`);
    case 'pausedBreak':
      return say(handlerInput, `Your break is paused. Say resume to continue it, or next round to start round ${state.roundNumber + 1}.`);
    default:
      return say(handlerInput, `Focus Mode is already active.`);
  }
}


/** PAUSE — freezes the ENTIRE Focus Mode timeline via the Timers pause API. */
async function doPause(handlerInput, client, state) {
  switch (state.status) {
    case 'pausedFocus':
      return say(handlerInput, `Focus Mode is already paused with ${speakDurationApprox(await getRemainingFocusMs(client, state))} left in round ${state.roundNumber}.`);
    case 'pausedBreak':
      return say(handlerInput, `Your break is already paused with ${speakDurationApprox(await getRemainingBreakMs(client, state))} left.`);
    case 'focus': {
      // Pause every still-active tracked timer: checkpoints, focus end, AND
      // break end. Already-fired timers are not pausable and are ignored;
      // partial failures are logged, never fatal.
      const timersMap = await listMyTimers(client);
      const keys = ['halfway', 'fiveLeft', 'focusEnd', 'breakEnd'];
      for (const key of keys) {
        const id = state.timerIds[key];
        if (!id) continue;
        const t = timersMap.get(id);
        if (!t || t.status !== 'ON') continue; // already fired or missing
        await pauseTimerSafe(client, id);
      }
      state.status = 'pausedFocus';
      await saveState(handlerInput, state);
      const remaining = await getRemainingFocusMs(client, state);
      return say(handlerInput, `Focus Mode is paused. You have ${speakDurationApprox(remaining)} left in round ${state.roundNumber}.`);
    }
    case 'break': {
      await pauseTimerSafe(client, state.timerIds.breakEnd);
      state.status = 'pausedBreak';
      await saveState(handlerInput, state);
      const remaining = await getRemainingBreakMs(client, state);
      return say(handlerInput, `Your break is paused with ${speakDurationApprox(remaining)} left.`);
    }
    case 'waiting':
      return say(handlerInput, `Nothing is running right now — round ${state.roundNumber} and its break are complete. Say resume or next round when you're ready.`);
    default:
      return say(handlerInput, `Focus Mode isn't running. Say start to begin round 1.`);
  }
}

/** RESUME — Case 1: paused timeline; Case 2: waiting -> next round. */
async function doResume(handlerInput, client, state) {
  switch (state.status) {
    case 'pausedFocus':
    case 'pausedBreak': {
      // Resume EVERY paused timer belonging to this timeline, then re-derive
      // the planned times from Alexa's fresh triggerTime values.
      const timersMap = await listMyTimers(client);
      const keys = ['halfway', 'fiveLeft', 'focusEnd', 'breakEnd'];
      for (const key of keys) {
        const id = state.timerIds[key];
        if (!id) continue;
        const t = timersMap.get(id);
        if (!t || t.status !== 'PAUSED') continue; // already fired or not paused
        await resumeTimerSafe(client, id);
      }
      const wasFocusPause = state.status === 'pausedFocus';
      state.status = wasFocusPause ? 'focus' : 'break';
      // Refresh planned times from the (now ON) timers.
      const focusT = await getTimerSafe(client, state.timerIds.focusEnd);
      if (focusT && focusT.triggerTime) state.plannedFocusEnd = parseIsoTimestampMs(focusT.triggerTime);
      const breakT = await getTimerSafe(client, state.timerIds.breakEnd);
      if (breakT && breakT.triggerTime) state.plannedBreakEnd = parseIsoTimestampMs(breakT.triggerTime);
      await saveState(handlerInput, state);
      if (wasFocusPause) {
        const remaining = await getRemainingFocusMs(client, state);
        return say(handlerInput, `Resuming round ${state.roundNumber}. You have ${speakDurationApprox(remaining)} left.`);
      }
      const remaining = await getRemainingBreakMs(client, state);
      return say(handlerInput, `Break resumed. ${speakDurationApprox(remaining)} left. Say next round when you're ready to start round ${state.roundNumber + 1}.`);
    }
    case 'focus': {
      // Already running — never create duplicate timers.
      const remaining = await getRemainingFocusMs(client, state);
      return say(handlerInput, `Focus Mode is already running. You have ${speakDurationApprox(remaining)} left in round ${state.roundNumber}.`);
    }
    case 'break': {
      const remaining = await getRemainingBreakMs(client, state);
      return say(handlerInput, `You're on your break with ${speakDurationApprox(remaining)} left. Say next round if you want to start round ${state.roundNumber + 1} early.`);
    }
    case 'waiting':
      return startNextRound(handlerInput, client, state);
    default:
      // Documented decision: "resume" from idle starts Round 1 — the most
      // natural interpretation for a single-user personal skill.
      return startNewSession(handlerInput, client, state);
  }
}

/** STOP — cancel every tracked timer and clear the session. */
async function doStop(handlerInput, client, state) {
  await cancelTrackedTimers(client, state);
  await clearState(handlerInput);
  console.log('Session stopped and cleared by user.');
  return say(handlerInput, `Focus Mode stopped. Your session has been cleared.`);
}


/** STATUS — report where the user is, using the Timer API where possible. */
async function doStatus(handlerInput, client, state) {
  switch (state.status) {
    case 'focus': {
      const remaining = await getRemainingFocusMs(client, state);
      return say(handlerInput, `You're on round ${state.roundNumber} with ${speakDurationPrecise(remaining)} left.`);
    }
    case 'break': {
      const remaining = await getRemainingBreakMs(client, state);
      return say(handlerInput, `You're on the break after round ${state.roundNumber}. ${speakDurationApprox(remaining)} remain.`);
    }
    case 'pausedFocus': {
      const remaining = await getRemainingFocusMs(client, state);
      return say(handlerInput, `Focus Mode is paused during round ${state.roundNumber} with ${speakDurationApprox(remaining)} remaining.`);
    }
    case 'pausedBreak': {
      const remaining = await getRemainingBreakMs(client, state);
      return say(handlerInput, `Your break is paused with ${speakDurationApprox(remaining)} remaining.`);
    }
    case 'waiting':
      return say(handlerInput, `Round ${state.roundNumber} and its break are complete. Say resume when you're ready for round ${state.roundNumber + 1}.`);
    default:
      return say(handlerInput, `Focus Mode isn't running. Say start to begin round 1.`);
  }
}

/** SKIP FOCUS — end the round early, immediately start its break. */
async function doSkipFocus(handlerInput, client, state) {
  switch (state.status) {
    case 'focus':
    case 'pausedFocus': {
      // Cancel everything left of this round (works even if paused).
      await cancelTrackedTimers(client, state, ['halfway', 'fiveLeft', 'focusEnd']);
      const breakMs = getBreakMs(state.roundNumber);
      const next = await createBreakTimer(client, breakMs);
      state.status = 'break';
      state.timerIds = { halfway: null, fiveLeft: null, focusEnd: null, breakEnd: next.timerIds.breakEnd };
      state.plannedFocusEnd = Date.now();
      state.plannedBreakEnd = next.plannedBreakEnd;
      await saveState(handlerInput, state);
      return say(handlerInput, `Okay. Ending round ${state.roundNumber} early. Your ${speakDurationAdj(breakMs)} break starts now.`);
    }
    case 'break':
    case 'pausedBreak':
      return say(handlerInput, `You're already on your break. Say skip break to end it early, or resume to keep waiting.`);
    case 'waiting':
      return say(handlerInput, `Round ${state.roundNumber} is already over. Say resume or next round when you're ready for round ${state.roundNumber + 1}.`);
    default:
      return say(handlerInput, `Focus Mode isn't running. Say start to begin round 1.`);
  }
}

/** SKIP BREAK — cancel the break timer and wait for the user. */
async function doSkipBreak(handlerInput, client, state) {
  switch (state.status) {
    case 'break':
    case 'pausedBreak': {
      await cancelTrackedTimers(client, state, ['breakEnd']);
      state.status = 'waiting';
      state.plannedBreakEnd = Date.now();
      await saveState(handlerInput, state);
      return say(handlerInput, `Break skipped. Say resume or next round when you're ready.`);
    }
    case 'focus':
    case 'pausedFocus':
      return say(handlerInput, `You're still in round ${state.roundNumber}. Say skip focus if you want to end it early.`);
    case 'waiting':
      return say(handlerInput, `Your break is already over. Say resume or next round when you're ready for round ${state.roundNumber + 1}.`);
    default:
      return say(handlerInput, `Focus Mode isn't running. Say start to begin round 1.`);
  }
}

/** NEXT ROUND — never starts a round while a focus round is active. */
async function doNextRound(handlerInput, client, state) {
  switch (state.status) {
    case 'focus':
    case 'pausedFocus':
      return say(handlerInput, `Round ${state.roundNumber} is already running. Say skip focus if you want to end it early.`);
    case 'break':
    case 'pausedBreak':
      // Cancel the remaining break and start the next round immediately.
      await cancelTrackedTimers(client, state, ['breakEnd']);
      return startNextRound(handlerInput, client, state);
    case 'waiting':
      return startNextRound(handlerInput, client, state);
    default:
      return startNewSession(handlerInput, client, state);
  }
}


// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

/**
 * Alexa-hosted skills periodically receive an availability-check LaunchRequest
 * from the pseudo-user "alexa-lambda-availability". It must be filtered out so
 * it never starts a session or creates timers.
 */
const AvailabilityCheckHandler = {
  canHandle(handlerInput) {
    const system = handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.System;
    const userId = system && system.user && system.user.userId;
    const sessionId = handlerInput.requestEnvelope.session && handlerInput.requestEnvelope.session.sessionId;
    return userId === 'alexa-lambda-availability'
      || (sessionId && String(sessionId).includes('alexa-lambda-availability'));
  },
  handle(handlerInput) {
    console.log('Filtered Alexa availability check.');
    return handlerInput.responseBuilder.getResponse();
  },
};

/** "Alexa, open Focus Mode" — always useful immediately, never duplicates. */
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    return withContext(handlerInput, 'start', async (hi, client, state) => {
      switch (state.status) {
        case 'idle':
          return startNewSession(hi, client, state);
        case 'focus': {
          const remaining = await getRemainingFocusMs(client, state);
          return say(hi, `Focus Mode is running. Round ${state.roundNumber} with ${speakDurationApprox(remaining)} left.`);
        }
        case 'break': {
          const remaining = await getRemainingBreakMs(client, state);
          return say(hi, `You're on the break after round ${state.roundNumber}, with ${speakDurationApprox(remaining)} left. Say next round when you're ready.`);
        }
        case 'pausedFocus':
          return say(hi, `Focus Mode is paused in round ${state.roundNumber} with ${speakDurationApprox(await getRemainingFocusMs(client, state))} remaining. Say resume to continue.`);
        case 'pausedBreak':
          return say(hi, `Your break is paused with ${speakDurationApprox(await getRemainingBreakMs(client, state))} remaining. Say resume to continue.`);
        case 'waiting':
          return say(hi, `Round ${state.roundNumber} is complete. Say next round or resume when you're ready.`);
        default:
          return say(hi, `Welcome to Focus Mode. Say start to begin round 1.`);
      }
    });
  },
};

const StartFocusIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'StartFocusIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'start', (hi, client, state) => doStart(hi, client, state));
  },
};

const PauseIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PauseIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'pause', (hi, client, state) => doPause(hi, client, state));
  },
};

const ResumeIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'resume', (hi, client, state) => doResume(hi, client, state));
  },
};

const StopAndCancelIntentHandler = {
  canHandle(handlerInput) {
    const name = Alexa.getIntentName(handlerInput.requestEnvelope);
    return name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'stop', (hi, client, state) => doStop(hi, client, state));
  },
};


const FocusStatusIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'FocusStatusIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'status', (hi, client, state) => doStatus(hi, client, state));
  },
};

const SkipFocusIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'SkipFocusIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'skipfocus', (hi, client, state) => doSkipFocus(hi, client, state));
  },
};

const SkipBreakIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'SkipBreakIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'skipbreak', (hi, client, state) => doSkipBreak(hi, client, state));
  },
};

const NextRoundIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'NextRoundIntent';
  },
  handle(handlerInput) {
    return withContext(handlerInput, 'next', (hi, client, state) => doNextRound(hi, client, state));
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    return say(handlerInput,
      `Focus Mode runs focus rounds of ${speakDuration(DUR.focusMs)}, with a ${speakDuration(DUR.breakOddMs)} break after odd rounds and a ${speakDuration(DUR.breakEvenMs)} break after even rounds. `
      + `You can say start, pause, resume, next round, time remaining, skip focus, skip break, or stop.`);
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    return say(handlerInput,
      `Sorry, I didn't catch that. You can say start, pause, resume, next round, time remaining, skip focus, skip break, or stop.`);
  },
};

/**
 * Outcome of the voice permission request. On ACCEPTED we continue the
 * original command directly (token carries which one) — no need to repeat it.
 */
const ConnectionsResponseHandler = {
  canHandle(handlerInput) {
    const req = Alexa.getRequestType(handlerInput.requestEnvelope) === 'Connections.Response'
      && handlerInput.requestEnvelope.request;
    return req && req.name === 'AskFor';
  },
  async handle(handlerInput) {
    const request = handlerInput.requestEnvelope.request;
    const token = request.token || '';
    const payload = request.payload || {};
    // API v2 puts status at payload level; be defensive about either shape.
    let status = payload.status;
    if (!status && Array.isArray(payload.permissionScopes) && payload.permissionScopes.length) {
      status = payload.permissionScopes[0].status;
    }
    console.log(`Connections.Response AskFor token=${token} status=${status || 'unknown'}`);

    if (status === 'ACCEPTED') {
      const ctx = await getContext(handlerInput);
      if (ctx.error) return ctx.response || say(handlerInput, `Permission granted. Try again in a moment.`);
      if (token === 'resume' || token === 'next') return doResume(handlerInput, ctx.client, ctx.state);
      return doStart(handlerInput, ctx.client, ctx.state); // 'start' and default
    }
    if (status === 'DENIED') {
      return handlerInput.responseBuilder
        .speak(`No problem. Without timer permission, Focus Mode can't schedule your rounds. You can enable it in the Alexa app under Skills, Focus Mode, Permissions, and then say start again.`)
        .withAskForPermissionsConsentCard([TIMERS_PERMISSION_SCOPE])
        .withShouldEndSession(true)
        .getResponse();
    }
    // NOT_ANSWERED (or unknown): Alexa re-prompts on its own; just close out.
    return say(handlerInput, `Whenever you're ready, say start to begin Focus Mode.`);
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    // Any cleanup logic goes here; sessions end on their own.
    return handlerInput.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    // Never expose raw stack traces through Alexa speech.
    console.error(`Unhandled error: ${error && (error.stack || error.message || error)}`);
    return say(handlerInput, `Sorry, something went wrong. Please try again.`);
  },
};

/** Lightweight request logging (no tokens or secrets are ever logged). */
const LogRequestInterceptor = {
  async process(handlerInput) {
    const req = handlerInput.requestEnvelope.request;
    const userId = handlerInput.requestEnvelope.context
      && handlerInput.requestEnvelope.context.System
      && handlerInput.requestEnvelope.context.System.user
      && handlerInput.requestEnvelope.context.System.user.userId;
    // Log only an anonymized hash fragment of the user ID — never the ID itself.
    let userTag;
    if (userId) {
      const crypto = require('crypto');
      userTag = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8);
    }
    console.log(JSON.stringify({
      event: 'request',
      type: req.type,
      intent: req.intent ? req.intent.name : undefined,
      userTag, // anonymous, non-reversible 8-char fragment
      testMode: TEST_MODE,
    }));
  },
};


// ---------------------------------------------------------------------------
// Skill assembly (Alexa-hosted skill; DynamoDB persistence is provisioned by
// Alexa and exposed through these environment variables)
// ---------------------------------------------------------------------------

const persistenceAdapter = new DynamoDbPersistenceAdapter({
  tableName: process.env.DYNAMODB_PERSISTENCE_TABLE_NAME || 'FocusModeUserData',
  partitionKeyName: 'id',
  // Outside Alexa-hosted (e.g. simulator/local), create the table if missing.
  createTable: !process.env.DYNAMODB_PERSISTENCE_TABLE_NAME,
  dynamoDBClient: new AWS.DynamoDB({
    apiVersion: 'latest',
    region: process.env.DYNAMODB_PERSISTENCE_REGION || 'us-east-1',
  }),
});

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    AvailabilityCheckHandler,        // must be first: filters availability checks
    LaunchRequestHandler,
    StartFocusIntentHandler,
    PauseIntentHandler,
    ResumeIntentHandler,
    StopAndCancelIntentHandler,
    FocusStatusIntentHandler,
    SkipFocusIntentHandler,
    SkipBreakIntentHandler,
    NextRoundIntentHandler,
    HelpIntentHandler,
    FallbackIntentHandler,
    ConnectionsResponseHandler,
    SessionEndedRequestHandler
  )
  .addRequestInterceptors(LogRequestInterceptor)
  .addErrorHandlers(ErrorHandler)
  .withPersistenceAdapter(persistenceAdapter)
  .lambda();

