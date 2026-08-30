# Productivity Score and Planned-versus-Actual Analysis

**Status:** Phase 1 proposal
**Implementation home:** `packages/domain/src/scoring/`

The brief (§19) asks for a transparent score, configurable, documented, with no single category able to dominate. This document is that specification. If the formula here and the code ever disagree, the code is wrong.

---

## 1. Design constraints

**A score must be reconstructable by the user.** Every daily score is stored with its full breakdown, and the API returns it. The UI can always answer "why is today 81 and not 90".

**A score must not punish a rest day.** A component with nothing to measure is dropped and the remaining weights are rescaled. A day with no planned workout is not a day with a failed workout.

**A score must not exist where there is no plan.** A day with zero planned activities scores `null`, not zero. Zero implies failure; null is the honest answer.

**A score must not become a stick.** No streak-shaming, no red days, no loss framing. The number sits beside its components, and the components are the useful part.

---

## 2. The formula

For each day, four components are evaluated. Each returns a raw value in [0, 1] and an eligibility flag.

```
eligible   = { c : component c has at least one measurable item today }
W          = Σ (weight_c) for c in eligible
score      = 100 × Σ (weight_c ÷ W × raw_c) for c in eligible
score      = null if eligible is empty
```

### Default weights

| Component           | Default weight | Configurable range |
| ------------------- | -------------- | ------------------ |
| Schedule completion | 0.35           | 0.10 to 0.40       |
| Habit completion    | 0.25           | 0.10 to 0.40       |
| Workout adherence   | 0.20           | 0.10 to 0.40       |
| Timeliness          | 0.20           | 0.10 to 0.40       |

Weights live in `user_preferences.score_weights`. They are clamped to the range on write and renormalised to sum to 1. The clamp is what stops any one category dominating, as the brief requires.

---

## 3. Component definitions

### 3.1 Schedule completion (weight 0.35)

Priority-weighted, so finishing the critical thing counts for more than finishing the easy thing.

```
raw_schedule = Σ (p_i × r_i) ÷ Σ (p_i)
```

over all activities planned for the day, excluding those with `source = 'sync'` (unplanned) and those with status `rescheduled` (they now belong to another day).

| Priority | p   |
| -------- | --- |
| low      | 1   |
| medium   | 2   |
| high     | 3   |
| critical | 5   |

| Status                | r                                            |
| --------------------- | -------------------------------------------- |
| completed             | 1.0                                          |
| partial               | the recorded `completion_ratio`, default 0.5 |
| active at day end     | 0.5                                          |
| skipped               | 0.0                                          |
| missed                | 0.0                                          |
| planned, day not over | excluded until the window has passed         |

Excluding not-yet-due activities matters: the score at 10am should reflect the morning, not predict a failed afternoon.

### 3.2 Habit completion (weight 0.25)

```
raw_habits = habits_completed_today ÷ habits_due_today
```

Due-ness comes from each habit's own schedule rule. A habit due Monday, Wednesday and Friday contributes nothing to a Tuesday score. For `count` and `duration` habits, partial credit is `min(1, value ÷ target)`.

Eligible only when at least one habit is due.

### 3.3 Workout adherence (weight 0.20)

| Situation                                      | raw                                                          |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Workout planned, completed                     | 1.0                                                          |
| Workout planned, session started and abandoned | `completed_sets ÷ target_sets`, capped at 1.0                |
| Workout planned, nothing recorded              | 0.0                                                          |
| No workout planned                             | **not eligible**, weight redistributed                       |
| No workout planned but one was done            | not eligible for the score, shown separately as a bonus note |

The last row is deliberate. An unplanned workout is good, but rewarding it inside a _plan adherence_ score would make the number mean two different things.

### 3.4 Timeliness (weight 0.20)

Measured only over activities that were actually started, using start deviation `d` in minutes.

```
punctuality(d) = 1.0                      if d ≤ 10
               = 1 − (d − 10) ÷ 50        if 10 < d < 60
               = 0.0                      if d ≥ 60

raw_timeliness = mean(punctuality(d_i)) over started activities
```

Starting early never penalises: negative `d` scores 1.0. The 10 minute grace band exists because a planner that treats a 4 minute delay as a failure is a planner people stop using.

Eligible only when at least one activity has a recorded `actual_start`.

---

## 4. A worked example

Thursday. 14 activities planned, 11 completed, 2 missed, 1 skipped. Four habits due, three done. A gym session was planned and completed. Nine activities were started with a mean punctuality of 0.62.

| Component                          | raw  | weight | normalised | contribution |
| ---------------------------------- | ---- | ------ | ---------- | ------------ |
| Schedule (priority-weighted, 0.83) | 0.83 | 0.35   | 0.35       | 29.1         |
| Habits (3 of 4)                    | 0.75 | 0.25   | 0.25       | 18.8         |
| Workout (completed)                | 1.00 | 0.20   | 0.20       | 20.0         |
| Timeliness                         | 0.62 | 0.20   | 0.20       | 12.4         |
| **Total**                          |      |        | 1.00       | **80.2**     |

Now the same day with no workout planned. The workout component is dropped, `W` becomes 0.80, and the remaining weights rescale to 0.4375, 0.3125, 0.25:

| Component  | raw  | normalised | contribution |
| ---------- | ---- | ---------- | ------------ |
| Schedule   | 0.83 | 0.4375     | 36.3         |
| Habits     | 0.75 | 0.3125     | 23.4         |
| Timeliness | 0.62 | 0.25       | 15.5         |
| **Total**  |      | 1.00       | **75.3**     |

The rest day scores on its own terms rather than being marked down for a workout that was never planned.

**Rounding.** The score is rounded to one decimal place, half up, from the unrounded total. Component contributions are rounded independently for display, so they can sum to 0.1 less or more than the headline figure (75.25 rounds to 75.3, while the displayed 36.3, 23.4 and 15.5 sum to 75.2). The total is authoritative; the components are an explanation, not a derivation.

---

## 5. Weekly and monthly aggregation

Weekly and monthly scores are the **mean of eligible daily scores**, never a recomputation over the pooled period. Days scoring `null` are excluded from the mean and reported separately as "unplanned days", so a fortnight of holiday does not read as a collapse in productivity.

Alongside the mean, the week view reports the spread (interquartile range). Consistency is the thing the brief actually cares about (§37: "am I becoming more consistent"), and an average alone hides it. A user averaging 70 every day is in a different position from one alternating 95 and 45, and the app should say so.

---

## 6. Planned versus actual analysis

Per activity, stored at completion:

- `start_deviation_minutes` = actual start minus planned start
- `duration_delta_minutes` = actual duration minus planned duration
- `adherence_ratio` = actual duration ÷ planned duration

Aggregated per series or per category over a trailing 30 days, using the **median** rather than the mean, so a single 3-hour outlier does not define the pattern.

### Reporting rules

A pattern is only surfaced when all three hold:

1. at least 8 observations in the window
2. median absolute deviation of at least 10 minutes
3. the direction is consistent in at least 70 percent of observations

And it is reported descriptively, with the evidence attached:

> "Over your last 14 gym sessions, the median start was 11 minutes after the planned time."

Not:

> "You struggle with motivation before workouts."

The brief (§18) says not to make unsupported psychological claims, and that rule is enforced here by only ever stating what was measured. The app reports timing; the user supplies the meaning.

### Useful derived views

- **Most-missed activities:** ranked by miss rate, minimum 5 occurrences, so a one-off does not top the list.
- **Best and worst hours:** completion rate bucketed by planned start hour. This tends to be the single most actionable output, because it tells the user where to move things.
- **Duration realism:** activities where median actual duration exceeds planned by more than 25 percent, offered with a one-tap "update the plan to match reality" action.

That last one is the point of the whole analytics section. The purpose is not to grade the user, it is to make the plan match the person.

---

## 7. Testing

Scoring lives in `packages/domain` as pure functions, so it is tested without a database.

- Table-driven tests over roughly 40 fixture days covering every component permutation, including all-ineligible (score is null), single-component days, and clamping at the weight bounds.
- Property test: the score is always in [0, 100] or null, for any generated input.
- Property test: renormalised weights always sum to 1 within floating-point tolerance.
- Regression test: the worked example in §4 above produces 80.2 and 75.3. If it ever does not, this document and the code have diverged.
