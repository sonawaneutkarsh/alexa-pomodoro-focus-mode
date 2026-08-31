# Focus Mode — custom Alexa skill (Echo Dot 5th Gen, en-US)

A Pomodoro-style personal Alexa skill: indefinite numbered 30-minute focus
rounds, spoken checkpoints at +15 and +25 minutes, an ANNOUNCEMENT (not a
ringing alarm) when the round ends, then a 5-minute (odd rounds) or 10-minute
(even rounds) break that ends with a NORMAL RINGING timer you dismiss by
tapping the Echo Dot. The next round NEVER starts automatically.

## Architecture in one paragraph

When you start (or resume into) a round, the skill creates all four Alexa
Timers for that round at once, while the skill session is still active
(required by the Timers API: create/pause/resume need an in-session token).
The three checkpoints use `triggeringBehavior: ANNOUNCE` with
`notificationConfig.playAudible: false` — Alexa SPEAKS the text when the timer
expires and nothing needs dismissing. The break-end timer uses
`NOTIFY_ONLY` + `playAudible: true` — a normal ringing timer. The skill then
closes its session; state (round number, timer IDs, planned times) is stored
in DynamoDB (provisioned automatically by Alexa-hosted skills). Because the
skill gets no callback when timers fire or are dismissed, every invocation
runs a reconciliation step against the Timers API before answering.

## Files

```
focus-mode/
  skill-package/
    skill.json                          # reference manifest (console manages this)
    interactionModels/custom/en-US.json # interaction model (paste into Build tab)
  lambda/
    index.js                            # all skill code
    package.json                        # dependencies (npm test runs the suite)
  test/
    smoke-test.js                       # offline smoke tests (no Alexa calls)
  LICENSE                               # MIT
```

## Quick start (Alexa-hosted)

1. https://developer.amazon.com/alexa/console/ask → **Create Skill**
2. Name: `Focus Mode`; **Custom** model; **Alexa-Hosted (Node.js)** → Create.
3. Build tab → **Permissions** (lower left) → turn ON **Timers**.
4. Build tab → JSON Editor → paste the contents of
   `skill-package/interactionModels/custom/en-US.json` → **Save** → **Build**.
5. Code tab: replace `lambda/index.js` with this project's `index.js` and
   `lambda/package.json` with this `package.json` → **Save** → **Deploy**.
6. Test tab → set development test ON → say "open focus mode" (or test on the
   Echo Dot signed into the same Amazon account — the skill is enabled
   automatically in development stage).
7. First run: Alexa asks for timer permission; say yes.

## TEST MODE (development only)

In `lambda/index.js`, set `const TEST_MODE = false;` to `true` and Deploy.
Durations become: focus 30 s, halfway +15 s, warning +25 s, break 5 s / 10 s.
**Always set it back to `false` and redeploy for real use** — production
defaults are 30/15/25/5/10 minutes.

## Voice commands

| Action | Phrase |
|---|---|
| Start | "Alexa, open Focus Mode." |
| Pause | "Alexa, ask Focus Mode to pause." |
| Resume | "Alexa, ask Focus Mode to resume." |
| Status | "Alexa, ask Focus Mode how much time is left." |
| Skip focus | "Alexa, ask Focus Mode to skip focus." |
| Skip break | "Alexa, ask Focus Mode to skip break." |
| Next round | "Alexa, ask Focus Mode for the next round." |
| Stop | "Alexa, ask Focus Mode to stop." |

Note: while a timer is RINGING, "Alexa, stop" (or a device tap) dismisses the
ringing natively — it does NOT invoke this skill. Use "ask Focus Mode to
stop" to end the whole session.

## Known Alexa-controlled behaviors (cannot be changed)

- Announcement timers are spoken with a prefix like "From Focus Mode: …".
- Announcement text is plain text only (no SSML).
- Max 25 skill timers, 2-hour max duration — Focus Mode uses 4.
- The skill is not notified when timers fire/dismiss; state is reconciled
  from the Timers API + stored timestamps on every invocation.

## Stale-session policy

If a session is older than 24 h (12 h for the waiting state) and Alexa
reports none of its timers alive, state resets to idle. "Stop" always clears
the session and restarts numbering at Round 1.

## Roadmap — features I'm thinking of adding / working on

The skill already works end-to-end as a timer; the items below would turn it
into a full productivity product. The **top 4 priorities** add the most value
without turning this into a giant project:

1. **Daily stats** *(top priority)* — "You completed 6 rounds today, 3 hours focused."
2. **Session goal** *(top priority)* — say "start 4 rounds" and it tracks progress toward that goal.
3. **Long break every N rounds** *(top priority)* — e.g. every 4 rounds, a 15–20 minute long break.
4. **Custom focus duration** *(top priority)* — "start a 45-minute focus round."

Also on the list:

- **Custom break length** — "give me a 7-minute break."
- **Varied start phrases** — rotate the round-start message so it never sounds repetitive.
- **End-of-round summary** — "Round 3 complete. You've focused for 90 minutes today."
- **Streaks** — consecutive days with at least one completed focus round.
- **Quick status** — "Alexa, ask Focus Mode how am I doing?"
- **Session history** — "How many rounds did I do yesterday?"
- **Named modes** — Deep Work, Study, Reading, Coding, each with its own timings.
- **Goal by time** — "Focus until 10 PM" and calculate how many rounds fit.
- **Automatic next-round mode** — a configurable option where the break ending flows straight into the next focus round.
- **Gentle break-end option** — instead of a ringing timer, speak once: "Break is over. Ready for round 4?"
- **Checkpoint toggles** — disable the halfway or five-minute warnings if you find them distracting.

The target experience for a "study session" mode:

> "Alexa, ask Focus Mode to start a study session."
> → 30 focus → 5 break → 30 → 10 → 30 → 5 → 30 → 20-minute long break
> → "Session complete. You finished 4 rounds and focused for 2 hours."

## License

MIT — see [LICENSE](LICENSE). Use it, remix it, ship your own version.
