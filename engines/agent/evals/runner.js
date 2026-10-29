// Runs the real agent headless over the question bank. This CONSUMES the user's plan, so it is manual only: the UI
// shows the estimated number of runs first. Learning is switched off during evaluation (no recommendations or lessons
// are created by test questions). Each question gets its own temporary chat, deleted afterwards.
import { openAgentStore } from '../agent-db.js';
import { loadDataset } from '../metrics.js';
import { loadSettings } from '../settings.js';
import { runTurn } from '../turn.js';
import { materialize, needsJudge } from './bank.js';
import { compareAnswer, describeExpected } from './compare.js';
import { runJudge } from './judge.js';
import { workspaceDir } from '../paths.js';

/** What a run will cost before starting it. */
export function estimateRun(ds, ids) {
  const qs = materialize(ds, ids);
  const runnable = qs.filter((q) => !q.skip);
  return { questions: qs.length, claudeRuns: runnable.length, judgeRuns: runnable.filter(needsJudge).length, skipped: qs.length - runnable.length };
}

export function bankForUi(ds) {
  return materialize(ds).map((q) => ({ id: q.id, category: q.category, question: q.question ?? '(no aplica con los datos actuales)', skip: q.skip ?? null, judged: needsJudge(q) }));
}

export async function runEval({ dataDir, ids, emit, registerCancel, claude, now = Date.now, judge = runJudge, turn = runTurn, dataset }) {
  const store = openAgentStore(dataDir);
  const settings = { ...loadSettings(dataDir), learning: false };
  let cancelled = false;
  let cancelTurn = null;
  registerCancel?.(() => {
    cancelled = true;
    cancelTurn?.();
  });
  try {
    const ds = dataset ?? loadDataset(dataDir, now());
    const questions = materialize(ds, ids?.length ? ids : undefined);
    const runId = store.createEvalRun({ total: questions.length, model: settings.model || 'predeterminado' });
    emit({ type: 'eval_start', runId, total: questions.length, estimate: estimateRun(ds, ids?.length ? ids : undefined) });
    const tally = { passed: 0, failed: 0, excluded: 0 };
    const usage = { total: 0, output: 0, turns: 0 };

    for (const [index, q] of questions.entries()) {
      if (cancelled) break;
      emit({ type: 'eval_progress', runId, index, total: questions.length, id: q.id, question: q.question ?? '', phase: 'asking' });
      const base = { runId, questionId: q.id, category: q.category, question: q.question ?? '' };
      const save = (status, extra) => {
        store.addEvalResult({ ...base, status, ...extra });
        tally[status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : 'excluded']++;
        emit({ type: 'eval_result', runId, index, id: q.id, status, detail: extra.detail ?? '' });
      };
      if (q.skip) {
        save('excluded', { detail: q.skip });
        continue;
      }

      const started = Date.now();
      let answer = '';
      let ungrounded = 0;
      let failure = null;
      const res = await turn({
        dataDir, text: q.question, claude, settings, store, now,
        registerCancel: (fn) => (cancelTurn = fn),
        emit: (ev) => {
          if (ev.type === 'step') emit({ type: 'eval_progress', runId, index, total: questions.length, id: q.id, question: q.question, phase: ev.label });
          if (ev.type === 'done') {
            answer = ev.text;
            ungrounded = ev.meta?.ungrounded?.length ?? 0;
            usage.total += ev.meta?.usage?.total ?? 0;
            usage.output += ev.meta?.usage?.output ?? 0;
            usage.turns += ev.meta?.turns ?? 0;
          }
          if (ev.type === 'error') failure = ev.error;
        },
      });
      cancelTurn = null;
      if (res.sessionId) store.deleteSession(res.sessionId);
      const ms = Date.now() - started;
      if (cancelled || res.cancelled) break;
      if (!res.ok) {
        save('excluded', { ...base, answer, ms, detail: `La consulta falló: ${failure ?? res.error ?? 'sin respuesta'}` });
        continue;
      }

      if (q.category === 'numeric') {
        const cmp = compareAnswer(answer, q.numbers, q.mention);
        const expected = describeExpected(q.numbers, q.mention);
        save(cmp.pass ? 'pass' : 'fail', {
          answer, ms, ungrounded, expected,
          detail: cmp.pass ? 'Coincide con los datos.' : `Falta en la respuesta: ${[...cmp.missing.map((n) => `${n.label} (${n.value})`), ...cmp.missingNames].join(', ')}.`,
        });
      } else {
        emit({ type: 'eval_progress', runId, index, total: questions.length, id: q.id, question: q.question, phase: 'Juzgando la respuesta…' });
        const verdict = await judge({ question: q.question, answer, rubric: q.rubric }, { claude, settings, cwd: workspaceDir(dataDir) });
        save(verdict.verdict === 'pass' ? 'pass' : verdict.verdict === 'fail' ? 'fail' : 'excluded', {
          answer, ms, ungrounded, expected: q.rubric, detail: verdict.verdict === 'undecidable' ? `Indeciso: ${verdict.reason}` : verdict.reason,
        });
      }
    }

    const status = cancelled ? 'cancelled' : 'done';
    store.finishEvalRun(runId, { status, ...tally, usage });
    const decided = tally.passed + tally.failed;
    emit({ type: 'eval_done', runId, status, ...tally, passRate: decided ? tally.passed / decided : null, usage });
    return { ok: !cancelled, runId, ...tally };
  } catch (error) {
    emit({ type: 'error', error: String(error?.message ?? error) });
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    store.close();
  }
}
