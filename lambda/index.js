'use strict';
/**
 * Focus Mode — a Pomodoro-style custom Alexa skill built on the Alexa Timers API.
 *
 * Every focus round pre-schedules four Alexa timers:
 *
 *   +15m        ANNOUNCE     halfway checkpoint
 *   +25m        ANNOUNCE     five-minute warning
 *   +30m        ANNOUNCE     focus complete / break begins
 *   +35m/+40m   NOTIFY_ONLY  break-end ringing timer
 *
 * Odd rounds get 5-minute breaks.
 * Even rounds get 10-minute breaks.
 *
 * The next focus round does NOT automatically begin after a break.
 * Say "Alexa, ask Focus Mode to resume" or "... next round".
 */

const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const { DynamoDbPersistenceAdapter } = require('ask-sdk-dynamodb-persistence-adapter');

// ===========================================================================
// PRODUCTION / TEST MODE
// ===========================================================================

const TEST_MODE = false;

const PRODUCTION_DURATIONS = {
  focusMs: 30 * 60 * 1000,
  halfwayMs: 15 * 60 * 1000,
  fiveLeftMs: 25 * 60 * 1000,
  breakOddMs: 5 * 60 * 1000,
  breakEvenMs: 10 * 60 * 1000,
};

const TEST_DURATIONS = {
  focusMs: 30 * 1000,
  halfwayMs: 15 * 1000,

  // During testing we moved this earlier so the warning
  // isn't immediately followed by the focus-end announcement.
  fiveLeftMs: 20 * 1000,

  breakOddMs: 5 * 1000,
  breakEvenMs: 10 * 1000,
};

const DUR = TEST_MODE ? TEST_DURATIONS : PRODUCTION_DURATIONS;

const TIMERS_PERMISSION_SCOPE = 'alexa::alerts:timers:skill:readwrite';

const LOCALE = 'en-US';

const STATE_KEY = 'focusMode';

const TIMER_LABELS = {
  halfway: 'Focus halfway',
  fiveLeft: 'Five left',
  focusEnd: 'Focus end',
  breakEnd: 'Focus break',
};

const STALE_ACTIVE_MS = 24 * 60 * 60 * 1000;

const STALE_WAITING_MS = 12 * 60 * 60 * 1000;

// ===========================================================================
// BASIC HELPERS
// ===========================================================================

function isoDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));

  const hours = Math.floor(totalSeconds / 3600);

  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const seconds = totalSeconds % 60;

  let out = 'PT';

  if (hours) {
    out += `${hours}H`;
  }

  if (minutes) {
    out += `${minutes}M`;
  }

  if (seconds) {
    out += `${seconds}S`;
  }

  return out === 'PT' ? 'PT1S' : out;
}

function parseIsoDurationMs(iso) {
  if (!iso || typeof iso !== 'string') {
    return null;
  }

  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso.trim());

  if (!match) {
    return null;
  }

  const [, days, hours, minutes, seconds] = match;

  return (
    (+(days || 0) * 86400 + +(hours || 0) * 3600 + +(minutes || 0) * 60 + +(seconds || 0)) * 1000
  );
}

function parseIsoTimestampMs(iso) {
  if (!iso) {
    return null;
  }

  const timestamp = Date.parse(iso);

  return Number.isNaN(timestamp) ? null : timestamp;
}

function parseBody(body) {
  if (!body) {
    return body;
  }

  return typeof body === 'string' ? JSON.parse(body) : body;
}

function speakDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);

  if (totalSeconds >= 60) {
    const minutes = Math.round(totalSeconds / 60);

    return `${minutes} minute` + `${minutes === 1 ? '' : 's'}`;
  }

  return `${totalSeconds} second` + `${totalSeconds === 1 ? '' : 's'}`;
}

function speakDurationPrecise(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));

  const minutes = Math.floor(totalSeconds / 60);

  const seconds = totalSeconds % 60;

  if (minutes > 0 && seconds > 0) {
    return (
      `${minutes} minute` +
      `${minutes === 1 ? '' : 's'} ` +
      `and ${seconds} second` +
      `${seconds === 1 ? '' : 's'}`
    );
  }

  if (minutes > 0) {
    return `${minutes} minute` + `${minutes === 1 ? '' : 's'}`;
  }

  return `${seconds} second` + `${seconds === 1 ? '' : 's'}`;
}

function speakDurationApprox(ms) {
  if (TEST_MODE) {
    return speakDurationPrecise(ms);
  }

  const minutes = Math.max(1, Math.round(ms / 60000));

  return `about ${minutes} minute` + `${minutes === 1 ? '' : 's'}`;
}

function speakDurationAdj(ms) {
  const totalSeconds = Math.round(ms / 1000);

  if (totalSeconds >= 60) {
    const minutes = Math.round(totalSeconds / 60);

    return `${minutes} minute`;
  }

  return `${totalSeconds} second`;
}

function getBreakMs(roundNumber) {
  return roundNumber % 2 === 1 ? DUR.breakOddMs : DUR.breakEvenMs;
}

// ===========================================================================
// TIMER API
// ===========================================================================

function getTimerClient(handlerInput) {
  const system =
    handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.System;

  if (!system || !system.apiAccessToken || !system.apiEndpoint) {
    return null;
  }

  try {
    return handlerInput.serviceClientFactory.getTimerManagementServiceClient();
  } catch (err) {
    console.error('getTimerManagementServiceClient failed:', err && err.message);

    return null;
  }
}

async function hasTimerPermission(client) {
  try {
    const response = await client.callGetTimers();

    return !!(response && response.statusCode === 200);
  } catch (err) {
    console.error('callGetTimers failed:', err && err.message);

    return false;
  }
}

async function listMyTimers(client) {
  const map = new Map();

  try {
    const response = await client.callGetTimers();

    if (response && response.statusCode === 200 && response.body) {
      const parsed = parseBody(response.body);

      for (const timer of parsed.timers || []) {
        if (timer && timer.id) {
          map.set(timer.id, timer);
        }
      }
    } else {
      console.warn('listMyTimers non-200:', response && response.statusCode);
    }
  } catch (err) {
    console.warn('listMyTimers failed:', err && err.message);
  }

  return map;
}

async function createTimer(client, timerRequest) {
  const response = await client.callCreateTimer(timerRequest);

  if (!response || response.statusCode !== 200 || !response.body) {
    let code = 'UNKNOWN';

    let message = `HTTP ${response ? response.statusCode : 'no response'}`;

    if (response && response.body) {
      try {
        const parsed = parseBody(response.body);

        code = parsed.code || code;

        message = parsed.message || message;
      } catch (err) {
        // Ignore malformed API error body.
      }
    }

    const error = new Error(`Timer create failed: ${code} ${message}`);

    error.code = code;

    throw error;
  }

  return parseBody(response.body);
}

async function getTimerSafe(client, timerId) {
  if (!timerId) {
    return null;
  }

  try {
    const response = await client.callGetTimer(timerId);

    if (response && response.statusCode === 200 && response.body) {
      return parseBody(response.body);
    }

    return null;
  } catch (err) {
    console.warn(`getTimer ${timerId} failed:`, err && err.message);

    return null;
  }
}

async function deleteTimerSafe(client, timerId) {
  if (!timerId) {
    return;
  }

  try {
    const response = await client.callDeleteTimer(timerId);

    console.log(`deleteTimer ${timerId} -> ${response ? response.statusCode : 'error'}`);
  } catch (err) {
    console.warn(`deleteTimer ${timerId} failed:`, err && err.message);
  }
}

async function pauseTimerSafe(client, timerId) {
  if (!timerId) {
    return 'notFound';
  }

  try {
    const response = await client.callPauseTimer(timerId);

    if (response && response.statusCode === 200) {
      console.log(`pauseTimer ${timerId} -> 200`);

      return 'paused';
    }

    if (response && response.body && String(response.body).includes('TIMER_ALREADY_PAUSED')) {
      return 'alreadyPaused';
    }

    return 'failed';
  } catch (err) {
    const message = err && err.message ? err.message : '';

    if (message.includes('TIMER_ALREADY_PAUSED')) {
      return 'alreadyPaused';
    }

    console.warn(`pauseTimer ${timerId} failed:`, message);

    return 'failed';
  }
}

async function resumeTimerSafe(client, timerId) {
  if (!timerId) {
    return 'notFound';
  }

  try {
    const response = await client.callResumeTimer(timerId);

    if (response && response.statusCode === 200) {
      console.log(`resumeTimer ${timerId} -> 200`);

      return 'resumed';
    }

    if (response && response.body && String(response.body).includes('TIMER_IS_NOT_PAUSED')) {
      return 'notPaused';
    }

    return 'failed';
  } catch (err) {
    const message = err && err.message ? err.message : '';

    if (message.includes('TIMER_IS_NOT_PAUSED')) {
      return 'notPaused';
    }

    console.warn(`resumeTimer ${timerId} failed:`, message);

    return 'failed';
  }
}

// ===========================================================================
// PERSISTENT STATE
// ===========================================================================

function freshState() {
  return {
    status: 'idle',

    roundNumber: 0,

    breakMs: null,

    timerIds: {},

    focusStartedAt: null,

    plannedFocusEnd: null,

    plannedBreakEnd: null,

    createdAt: Date.now(),

    updatedAt: Date.now(),
  };
}

async function loadState(handlerInput) {
  try {
    const attributes = await handlerInput.attributesManager.getPersistentAttributes();

    const state = attributes[STATE_KEY];

    if (!state || typeof state !== 'object') {
      return freshState();
    }

    return Object.assign(freshState(), state);
  } catch (err) {
    console.warn('loadState failed:', err && err.message);

    return freshState();
  }
}

async function saveState(handlerInput, state) {
  state.updatedAt = Date.now();

  try {
    const attributes = await handlerInput.attributesManager.getPersistentAttributes();

    attributes[STATE_KEY] = state;

    handlerInput.attributesManager.setPersistentAttributes(attributes);

    await handlerInput.attributesManager.savePersistentAttributes();
  } catch (err) {
    console.error('saveState failed:', err && err.message);
  }
}

async function clearState(handlerInput) {
  await saveState(handlerInput, freshState());
}

// ===========================================================================
// TIMER BUILDERS
// ===========================================================================

function buildAnnounceTimer(label, delayMs, text) {
  return {
    duration: isoDuration(delayMs),

    timerLabel: label,

    creationBehavior: {
      displayExperience: {
        visibility: 'VISIBLE',
      },
    },

    triggeringBehavior: {
      operation: {
        type: 'ANNOUNCE',

        textToAnnounce: [
          {
            locale: LOCALE,

            text,
          },
        ],
      },

      notificationConfig: {
        playAudible: false,
      },
    },
  };
}

function buildRingingTimer(label, delayMs) {
  return {
    duration: isoDuration(delayMs),

    timerLabel: label,

    creationBehavior: {
      displayExperience: {
        visibility: 'VISIBLE',
      },
    },

    triggeringBehavior: {
      operation: {
        type: 'NOTIFY_ONLY',
      },

      notificationConfig: {
        playAudible: true,
      },
    },
  };
}

// ===========================================================================
// ROUND TIMER CREATION
// ===========================================================================

async function createRoundTimers(client, roundNumber) {
  const breakMs = getBreakMs(roundNumber);

  const halfwayText =
    `You're halfway through round ${roundNumber}. ` +
    `${speakDuration(DUR.focusMs - DUR.halfwayMs)} left.`;

  const fiveLeftText =
    `Nice work. ` + `${speakDuration(DUR.focusMs - DUR.fiveLeftMs)} left in round ${roundNumber}.`;

  const focusEndText =
    `Nice work. Round ${roundNumber} is complete. ` +
    `Your ${speakDurationAdj(breakMs)} break starts now.`;

  const specifications = [
    {
      key: 'halfway',

      request: buildAnnounceTimer(TIMER_LABELS.halfway, DUR.halfwayMs, halfwayText),
    },

    {
      key: 'fiveLeft',

      request: buildAnnounceTimer(TIMER_LABELS.fiveLeft, DUR.fiveLeftMs, fiveLeftText),
    },

    {
      key: 'focusEnd',

      request: buildAnnounceTimer(TIMER_LABELS.focusEnd, DUR.focusMs, focusEndText),
    },

    {
      key: 'breakEnd',

      request: buildRingingTimer(TIMER_LABELS.breakEnd, DUR.focusMs + breakMs),
    },
  ];

  const created = [];

  const timerIds = {};

  try {
    for (const specification of specifications) {
      const timer = await createTimer(client, specification.request);

      console.log(`created timer ${specification.key}: ${timer.id}`);

      timerIds[specification.key] = timer.id;

      created.push(timer);
    }

    const now = Date.now();

    return {
      timerIds,

      plannedTimes: {
        halfway: parseIsoTimestampMs(created[0].triggerTime) || now + DUR.halfwayMs,

        fiveLeft: parseIsoTimestampMs(created[1].triggerTime) || now + DUR.fiveLeftMs,

        focusEnd: parseIsoTimestampMs(created[2].triggerTime) || now + DUR.focusMs,

        breakEnd: parseIsoTimestampMs(created[3].triggerTime) || now + DUR.focusMs + breakMs,
      },

      breakMs,
    };
  } catch (err) {
    console.error('createRoundTimers partial failure:', err && err.message);

    for (const id of Object.values(timerIds)) {
      await deleteTimerSafe(client, id);
    }

    throw err;
  }
}

async function createBreakTimer(client, breakMs) {
  const timer = await createTimer(
    client,

    buildRingingTimer(TIMER_LABELS.breakEnd, breakMs),
  );

  return {
    timerIds: {
      breakEnd: timer.id,
    },

    plannedBreakEnd: parseIsoTimestampMs(timer.triggerTime) || Date.now() + breakMs,
  };
}

async function cancelTrackedTimers(client, state, keys) {
  const toDelete = keys || Object.keys(state.timerIds || {});

  for (const key of toDelete) {
    await deleteTimerSafe(
      client,

      state.timerIds ? state.timerIds[key] : undefined,
    );
  }
}

// ===========================================================================
// STATE RECONCILIATION
// ===========================================================================

function reconcileState(state, timersMap) {
  if (!state || state.status === 'idle') {
    return state;
  }

  const now = Date.now();

  const live = {};

  for (const [key, id] of Object.entries(state.timerIds || {})) {
    if (id && timersMap && timersMap.has(id)) {
      live[key] = timersMap.get(id);
    }
  }

  switch (state.status) {
    case 'focus': {
      if (now >= state.plannedFocusEnd) {
        state.status = state.plannedBreakEnd && now < state.plannedBreakEnd ? 'break' : 'waiting';
      }

      break;
    }

    case 'break': {
      if (now >= state.plannedBreakEnd) {
        state.status = 'waiting';
      }

      break;
    }

    case 'pausedFocus': {
      const timer = live.focusEnd;

      if (!timer || timer.status === 'OFF') {
        state.status = 'waiting';
      } else if (timer.status === 'ON') {
        state.status = 'focus';
      }

      break;
    }

    case 'pausedBreak': {
      const timer = live.breakEnd;

      if (!timer || timer.status === 'OFF') {
        state.status = 'waiting';
      } else if (timer.status === 'ON') {
        state.status = 'break';
      }

      break;
    }

    default:
      break;
  }

  const age = now - (state.updatedAt || state.createdAt || now);

  const threshold = state.status === 'waiting' ? STALE_WAITING_MS : STALE_ACTIVE_MS;

  const isActiveState = ['focus', 'break', 'pausedFocus', 'pausedBreak', 'waiting'].includes(
    state.status,
  );

  if (isActiveState && age > threshold && Object.keys(live).length === 0) {
    console.warn('Stale Focus Mode session detected; resetting.');

    return freshState();
  }

  return state;
}

// ===========================================================================
// REMAINING TIME
// ===========================================================================

async function getRemainingFocusMs(client, state) {
  const timer = await getTimerSafe(
    client,

    state.timerIds && state.timerIds.focusEnd,
  );

  if (timer && timer.status === 'ON' && timer.triggerTime) {
    return Math.max(
      0,

      parseIsoTimestampMs(timer.triggerTime) - Date.now(),
    );
  }

  if (timer && timer.status === 'PAUSED' && timer.remainingTimeWhenPaused) {
    return parseIsoDurationMs(timer.remainingTimeWhenPaused) || 0;
  }

  return Math.max(
    0,

    (state.plannedFocusEnd || 0) - Date.now(),
  );
}

async function getRemainingBreakMs(client, state) {
  const timer = await getTimerSafe(
    client,

    state.timerIds && state.timerIds.breakEnd,
  );

  if (timer && timer.status === 'ON' && timer.triggerTime) {
    return Math.max(
      0,

      parseIsoTimestampMs(timer.triggerTime) - Date.now(),
    );
  }

  if (timer && timer.status === 'PAUSED' && timer.remainingTimeWhenPaused) {
    return parseIsoDurationMs(timer.remainingTimeWhenPaused) || 0;
  }

  return Math.max(
    0,

    (state.plannedBreakEnd || 0) - Date.now(),
  );
}

// ===========================================================================
// SPEECH / PERMISSION
// ===========================================================================

function say(handlerInput, text) {
  return handlerInput.responseBuilder.speak(text).withShouldEndSession(true).getResponse();
}

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

// ===========================================================================
// CONTEXT / PERMISSION GATE
// ===========================================================================

async function getContext(handlerInput) {
  const client = getTimerClient(handlerInput);

  if (!client) {
    return {
      error: true,

      response: say(
        handlerInput,

        `Sorry, I can't manage timers from this request. Try again from your Echo.`,
      ),
    };
  }

  if (!(await hasTimerPermission(client))) {
    return {
      error: true,
      permissionNeeded: true,
    };
  }

  let state = await loadState(handlerInput);

  const timersMap = await listMyTimers(client);

  const before = state.status;

  state = reconcileState(state, timersMap);

  if (state.status !== before) {
    console.log(`reconcileState: ${before} -> ${state.status}`);

    await saveState(handlerInput, state);
  }

  return {
    client,
    state,
    timersMap,
  };
}

async function withContext(handlerInput, token, fn) {
  const context = await getContext(handlerInput);

  if (context.error) {
    if (context.permissionNeeded) {
      return requestTimerPermission(handlerInput, token);
    }

    return context.response;
  }

  try {
    return await fn(handlerInput, context.client, context.state, context.timersMap);
  } catch (err) {
    console.error('Intent handling error:', err && err.message);

    return say(
      handlerInput,

      `Sorry, something went wrong. Please try again.`,
    );
  }
}

// ===========================================================================
// START ROUND
// ===========================================================================

async function startNewSession(handlerInput, client, state) {
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

    return say(
      handlerInput,

      `Round ${round} is starting now. Focus for ${speakDuration(DUR.focusMs)}.`,
    );
  } catch (err) {
    console.error('startNewSession failed:', err && err.message);

    if (err.code === 'MAX_TIMERS_EXCEEDED') {
      return say(
        handlerInput,

        `I couldn't set the timers because there are too many timers on this device. Remove the ones you don't need, then start again.`,
      );
    }

    return say(
      handlerInput,

      `Sorry, something went wrong while setting up Focus Mode. Please try again.`,
    );
  }
}

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

    return say(
      handlerInput,

      `Round ${round} is starting now. Focus for ${speakDuration(DUR.focusMs)}.`,
    );
  } catch (err) {
    console.error('startNextRound failed:', err && err.message);

    if (err.code === 'MAX_TIMERS_EXCEEDED') {
      return say(
        handlerInput,

        `I couldn't set the timers because there are too many timers on this device.`,
      );
    }

    return say(
      handlerInput,

      `Sorry, something went wrong while starting round ${round}. Please try again.`,
    );
  }
}

// ===========================================================================
// START
// ===========================================================================

async function doStart(handlerInput, client, state) {
  switch (state.status) {
    case 'idle':
      return startNewSession(handlerInput, client, state);

    case 'waiting':
      return startNextRound(handlerInput, client, state);

    case 'focus': {
      const remaining = await getRemainingFocusMs(client, state);

      return say(
        handlerInput,

        `Focus Mode is already running. You have ${speakDurationApprox(remaining)} left in round ${state.roundNumber}.`,
      );
    }

    case 'break': {
      const remaining = await getRemainingBreakMs(client, state);

      return say(
        handlerInput,

        `You're on your break with ${speakDurationApprox(remaining)} left. Say next round to start round ${state.roundNumber + 1} early.`,
      );
    }

    case 'pausedFocus':
      return say(
        handlerInput,

        `Focus Mode is paused in round ${state.roundNumber}. Say resume to continue.`,
      );

    case 'pausedBreak':
      return say(
        handlerInput,

        `Your break is paused. Say resume to continue it, or next round to start round ${state.roundNumber + 1}.`,
      );

    default:
      return say(handlerInput, `Focus Mode is already active.`);
  }
}

// ===========================================================================
// PAUSE
// ===========================================================================

async function doPause(handlerInput, client, state) {
  switch (state.status) {
    case 'pausedFocus': {
      const remaining = await getRemainingFocusMs(client, state);

      return say(
        handlerInput,

        `Focus Mode is already paused with ${speakDurationApprox(remaining)} left in round ${state.roundNumber}.`,
      );
    }

    case 'pausedBreak': {
      const remaining = await getRemainingBreakMs(client, state);

      return say(
        handlerInput,

        `Your break is already paused with ${speakDurationApprox(remaining)} left.`,
      );
    }

    case 'focus': {
      const timersMap = await listMyTimers(client);

      const keys = ['halfway', 'fiveLeft', 'focusEnd', 'breakEnd'];

      for (const key of keys) {
        const id = state.timerIds[key];

        if (!id) {
          continue;
        }

        const timer = timersMap.get(id);

        if (!timer || timer.status !== 'ON') {
          continue;
        }

        await pauseTimerSafe(client, id);
      }

      state.status = 'pausedFocus';

      await saveState(handlerInput, state);

      const remaining = await getRemainingFocusMs(client, state);

      return say(
        handlerInput,

        `Focus Mode is paused. You have ${speakDurationApprox(remaining)} left in round ${state.roundNumber}.`,
      );
    }

    case 'break': {
      await pauseTimerSafe(client, state.timerIds.breakEnd);

      state.status = 'pausedBreak';

      await saveState(handlerInput, state);

      const remaining = await getRemainingBreakMs(client, state);

      return say(
        handlerInput,

        `Your break is paused with ${speakDurationApprox(remaining)} left.`,
      );
    }

    case 'waiting':
      return say(
        handlerInput,

        `Nothing is running right now. Say resume or next round when you're ready.`,
      );

    default:
      return say(
        handlerInput,

        `Focus Mode isn't running. Say start to begin round 1.`,
      );
  }
}

// ===========================================================================
// RESUME
// ===========================================================================

async function doResume(handlerInput, client, state) {
  switch (state.status) {
    case 'pausedFocus':
    case 'pausedBreak': {
      const timersMap = await listMyTimers(client);

      const keys = ['halfway', 'fiveLeft', 'focusEnd', 'breakEnd'];

      for (const key of keys) {
        const id = state.timerIds[key];

        if (!id) {
          continue;
        }

        const timer = timersMap.get(id);

        if (!timer || timer.status !== 'PAUSED') {
          continue;
        }

        await resumeTimerSafe(client, id);
      }

      const wasFocusPause = state.status === 'pausedFocus';

      state.status = wasFocusPause ? 'focus' : 'break';

      const focusTimer = await getTimerSafe(client, state.timerIds.focusEnd);

      if (focusTimer && focusTimer.triggerTime) {
        state.plannedFocusEnd = parseIsoTimestampMs(focusTimer.triggerTime);
      }

      const breakTimer = await getTimerSafe(client, state.timerIds.breakEnd);

      if (breakTimer && breakTimer.triggerTime) {
        state.plannedBreakEnd = parseIsoTimestampMs(breakTimer.triggerTime);
      }

      await saveState(handlerInput, state);

      if (wasFocusPause) {
        const remaining = await getRemainingFocusMs(client, state);

        return say(
          handlerInput,

          `Resuming round ${state.roundNumber}. You have ${speakDurationApprox(remaining)} left.`,
        );
      }

      const remaining = await getRemainingBreakMs(client, state);

      return say(
        handlerInput,

        `Break resumed. ${speakDurationApprox(remaining)} left.`,
      );
    }

    case 'focus': {
      const remaining = await getRemainingFocusMs(client, state);

      return say(
        handlerInput,

        `Focus Mode is already running. You have ${speakDurationApprox(remaining)} left in round ${state.roundNumber}.`,
      );
    }

    case 'break': {
      const remaining = await getRemainingBreakMs(client, state);

      return say(
        handlerInput,

        `You're on your break with ${speakDurationApprox(remaining)} left.`,
      );
    }

    case 'waiting':
      return startNextRound(handlerInput, client, state);

    default:
      return startNewSession(handlerInput, client, state);
  }
}

// ===========================================================================
// STOP
// ===========================================================================

async function doStop(handlerInput, client, state) {
  await cancelTrackedTimers(client, state);

  await clearState(handlerInput);

  console.log('Focus Mode session stopped and cleared.');

  return say(
    handlerInput,

    `Focus Mode stopped. Your session has been cleared.`,
  );
}

// ===========================================================================
// STATUS
// ===========================================================================

async function doStatus(handlerInput, client, state) {
  switch (state.status) {
    case 'focus': {
      const remaining = await getRemainingFocusMs(client, state);

      return say(
        handlerInput,

        `You're on round ${state.roundNumber} with ${speakDurationPrecise(remaining)} left.`,
      );
    }

    case 'break': {
      const remaining = await getRemainingBreakMs(client, state);

      return say(
        handlerInput,

        `You're on the break after round ${state.roundNumber}. ${speakDurationApprox(remaining)} remain.`,
      );
    }

    case 'pausedFocus': {
      const remaining = await getRemainingFocusMs(client, state);

      return say(
        handlerInput,

        `Focus Mode is paused during round ${state.roundNumber} with ${speakDurationApprox(remaining)} remaining.`,
      );
    }

    case 'pausedBreak': {
      const remaining = await getRemainingBreakMs(client, state);

      return say(
        handlerInput,

        `Your break is paused with ${speakDurationApprox(remaining)} remaining.`,
      );
    }

    case 'waiting':
      return say(
        handlerInput,

        `Round ${state.roundNumber} and its break are complete. Say resume when you're ready for round ${state.roundNumber + 1}.`,
      );

    default:
      return say(
        handlerInput,

        `Focus Mode isn't running. Say start to begin round 1.`,
      );
  }
}

// ===========================================================================
// SKIP FOCUS
// ===========================================================================

async function doSkipFocus(handlerInput, client, state) {
  switch (state.status) {
    case 'focus':
    case 'pausedFocus': {
      await cancelTrackedTimers(client, state, ['halfway', 'fiveLeft', 'focusEnd', 'breakEnd']);

      const breakMs = getBreakMs(state.roundNumber);

      const result = await createBreakTimer(client, breakMs);

      state.status = 'break';

      state.timerIds = {
        halfway: null,
        fiveLeft: null,
        focusEnd: null,

        breakEnd: result.timerIds.breakEnd,
      };

      state.plannedFocusEnd = Date.now();

      state.plannedBreakEnd = result.plannedBreakEnd;

      await saveState(handlerInput, state);

      return say(
        handlerInput,

        `Okay. Ending round ${state.roundNumber} early. Your ${speakDurationAdj(breakMs)} break starts now.`,
      );
    }

    case 'break':
    case 'pausedBreak':
      return say(
        handlerInput,

        `You're already on your break. Say skip break to end it early.`,
      );

    case 'waiting':
      return say(
        handlerInput,

        `Round ${state.roundNumber} is already over. Say resume or next round when you're ready.`,
      );

    default:
      return say(
        handlerInput,

        `Focus Mode isn't running.`,
      );
  }
}

// ===========================================================================
// SKIP BREAK
// ===========================================================================

async function doSkipBreak(handlerInput, client, state) {
  switch (state.status) {
    case 'break':
    case 'pausedBreak': {
      await cancelTrackedTimers(client, state, ['breakEnd']);

      state.status = 'waiting';

      state.plannedBreakEnd = Date.now();

      await saveState(handlerInput, state);

      return say(
        handlerInput,

        `Break skipped. Say resume or next round when you're ready.`,
      );
    }

    case 'focus':
    case 'pausedFocus':
      return say(
        handlerInput,

        `You're still in round ${state.roundNumber}. Say skip focus if you want to end it early.`,
      );

    case 'waiting':
      return say(
        handlerInput,

        `Your break is already over. Say resume or next round when you're ready.`,
      );

    default:
      return say(
        handlerInput,

        `Focus Mode isn't running.`,
      );
  }
}

// ===========================================================================
// NEXT ROUND
// ===========================================================================

async function doNextRound(handlerInput, client, state) {
  switch (state.status) {
    case 'focus':
    case 'pausedFocus':
      return say(
        handlerInput,

        `Round ${state.roundNumber} is already running. Say skip focus if you want to end it early.`,
      );

    case 'break':
    case 'pausedBreak':
      await cancelTrackedTimers(client, state, ['breakEnd']);

      return startNextRound(handlerInput, client, state);

    case 'waiting':
      return startNextRound(handlerInput, client, state);

    default:
      return startNewSession(handlerInput, client, state);
  }
}

// ===========================================================================
// REQUEST HANDLERS
// ===========================================================================

const AvailabilityCheckHandler = {
  canHandle(handlerInput) {
    const system =
      handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.System;

    const userId = system && system.user && system.user.userId;

    const sessionId =
      handlerInput.requestEnvelope.session && handlerInput.requestEnvelope.session.sessionId;

    return (
      userId === 'alexa-lambda-availability' ||
      (sessionId && String(sessionId).includes('alexa-lambda-availability'))
    );
  },

  handle(handlerInput) {
    console.log('Filtered Alexa availability check.');

    return handlerInput.responseBuilder.getResponse();
  },
};

// IMPORTANT:
// Must appear before ordinary IntentRequest handlers.
const ConnectionsResponseHandler = {
  canHandle(handlerInput) {
    if (Alexa.getRequestType(handlerInput.requestEnvelope) !== 'Connections.Response') {
      return false;
    }

    const request = handlerInput.requestEnvelope.request;

    return request && request.name === 'AskFor';
  },

  async handle(handlerInput) {
    const request = handlerInput.requestEnvelope.request;

    const token = request.token || '';

    const payload = request.payload || {};

    let status = payload.status;

    if (!status && Array.isArray(payload.permissionScopes) && payload.permissionScopes.length) {
      status = payload.permissionScopes[0].status;
    }

    console.log(`Connections.Response AskFor token=${token} status=${status || 'unknown'}`);

    if (status === 'ACCEPTED') {
      const context = await getContext(handlerInput);

      if (context.error) {
        return (
          context.response ||
          say(
            handlerInput,

            `Permission granted. Try again in a moment.`,
          )
        );
      }

      if (token === 'resume') {
        return doResume(handlerInput, context.client, context.state);
      }

      if (token === 'next') {
        return doNextRound(handlerInput, context.client, context.state);
      }

      return doStart(handlerInput, context.client, context.state);
    }

    if (status === 'DENIED') {
      return handlerInput.responseBuilder

        .speak(`No problem. Without timer permission, Focus Mode can't schedule your rounds.`)

        .withAskForPermissionsConsentCard([TIMERS_PERMISSION_SCOPE])

        .withShouldEndSession(true)

        .getResponse();
    }

    return say(
      handlerInput,

      `Whenever you're ready, say start to begin Focus Mode.`,
    );
  },
};

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },

  handle(handlerInput) {
    return withContext(
      handlerInput,
      'start',

      (hi, client, state) => doStart(hi, client, state),
    );
  },
};

const StartFocusIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'StartFocusIntent'
    );
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'start', doStart);
  },
};

const PauseIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PauseIntent'
    );
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'pause', doPause);
  },
};

const ResumeIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent'
    );
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'resume', doResume);
  },
};

const StopAndCancelIntentHandler = {
  canHandle(handlerInput) {
    if (Alexa.getRequestType(handlerInput.requestEnvelope) !== 'IntentRequest') {
      return false;
    }

    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);

    return intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent';
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'stop', doStop);
  },
};

const FocusStatusIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'FocusStatusIntent'
    );
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'status', doStatus);
  },
};

const SkipFocusIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'SkipFocusIntent'
    );
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'skipfocus', doSkipFocus);
  },
};

const SkipBreakIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'SkipBreakIntent'
    );
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'skipbreak', doSkipBreak);
  },
};

const NextRoundIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'NextRoundIntent'
    );
  },

  handle(handlerInput) {
    return withContext(handlerInput, 'next', doNextRound);
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent'
    );
  },

  handle(handlerInput) {
    return say(
      handlerInput,

      `Focus Mode uses ${speakDuration(DUR.focusMs)} focus rounds. You can say start, pause, resume, next round, time remaining, skip focus, skip break, or stop.`,
    );
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent'
    );
  },

  handle(handlerInput) {
    return say(
      handlerInput,

      `Sorry, I didn't catch that. You can say start, pause, resume, next round, time remaining, skip focus, skip break, or stop.`,
    );
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  },
};

// ===========================================================================
// ERROR HANDLER
// ===========================================================================

const ErrorHandler = {
  canHandle() {
    return true;
  },

  handle(handlerInput, error) {
    console.error('Unhandled error:', error && (error.stack || error.message || error));

    return say(
      handlerInput,

      `Sorry, something went wrong. Please try again.`,
    );
  },
};

// ===========================================================================
// REQUEST LOGGING
// ===========================================================================

const LogRequestInterceptor = {
  async process(handlerInput) {
    const request = handlerInput.requestEnvelope.request;

    const system =
      handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.System;

    const userId = system && system.user && system.user.userId;

    // Never log the complete user ID. Log only an 8-hex SHA-256 fragment:
    // a stable pseudonymous tag for correlating requests, not the raw ID.
    const userTag = userId
      ? crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8)
      : undefined;

    console.log(
      JSON.stringify({
        event: 'request',

        type: request.type,

        intent: request.intent ? request.intent.name : undefined,

        userTag, // anonymous 8-char hash fragment

        testMode: TEST_MODE,
      }),
    );
  },
};

// ===========================================================================
// DYNAMODB
// ===========================================================================

const persistenceAdapter = new DynamoDbPersistenceAdapter({
  tableName: process.env.DYNAMODB_PERSISTENCE_TABLE_NAME || 'FocusModeUserData',

  partitionKeyName: 'id',

  createTable: !process.env.DYNAMODB_PERSISTENCE_TABLE_NAME,

  dynamoDBClient: new AWS.DynamoDB({
    apiVersion: 'latest',

    region: process.env.DYNAMODB_PERSISTENCE_REGION || 'us-east-1',
  }),
});

// ===========================================================================
// SKILL EXPORT
//
// IMPORTANT:
// 1. DefaultApiClient is required for serviceClientFactory.
// 2. ConnectionsResponseHandler must appear before ordinary intent handlers.
// ===========================================================================

exports.handler = Alexa.SkillBuilders.custom()

  .withApiClient(new Alexa.DefaultApiClient())

  .addRequestHandlers(
    AvailabilityCheckHandler,

    ConnectionsResponseHandler,

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

    SessionEndedRequestHandler,
  )

  .addRequestInterceptors(LogRequestInterceptor)

  .addErrorHandlers(ErrorHandler)

  .withPersistenceAdapter(persistenceAdapter)

  .lambda();
